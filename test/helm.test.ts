import { afterEach, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { stringify } from 'yaml';
import {
  helmStatus,
  HELM_VIEW,
  parseHelmHistory,
  parseHelmList,
  releaseObject,
  repoCandidates,
  safeChartPath,
  splitChart,
  validChartRef,
  validChartVersion,
  validNamespaceName,
  validReleaseName,
  validRevision,
} from '../src/shared/helm.ts';
import { cellText, rowText, sortRows, statusOf } from '../src/shared/kinds.ts';
import { chartFiles, decodeRecord, helmError, listReleases, panelManifest, panelValues, rebuildProblem, rollbackRelease, setHelmRunner, uninstallRelease, upgradeRelease } from '../src/service/helm.ts';
import { REDACTED } from '../src/shared/redact.ts';
import { K8sError } from '../src/service/errors.ts';

describe('splitChart', () => {
  test('splits the name from the version', () => {
    expect(splitChart('contracts-1.0.0')).toEqual({ name: 'contracts', version: '1.0.0' });
    expect(splitChart('haproxy-ingress-0.14.10')).toEqual({ name: 'haproxy-ingress', version: '0.14.10' });
    expect(splitChart('ld-relay-3.10.0')).toEqual({ name: 'ld-relay', version: '3.10.0' });
    expect(splitChart('cert-manager-v1.14.0')).toEqual({ name: 'cert-manager', version: 'v1.14.0' });
    expect(splitChart('app-1.2.3-rc.1')).toEqual({ name: 'app', version: '1.2.3-rc.1' });
    expect(splitChart('app-1.2.3+build.5')).toEqual({ name: 'app', version: '1.2.3+build.5' });
    expect(splitChart('foo-2fa-1.0.0')).toEqual({ name: 'foo-2fa', version: '1.0.0' });
  });

  test('a label with no version keeps the whole text as the name', () => {
    expect(splitChart('weird')).toEqual({ name: 'weird', version: '' });
  });
});

describe('parseHelmList', () => {
  const output = JSON.stringify([
    { name: 'a', namespace: 'x', revision: '3', updated: '2026-11-12T16:23:27Z', status: 'deployed', chart: 'a-1.0.0', app_version: '2.0' },
    { name: 'broken' },
    { name: 'b', namespace: 'y', revision: '1', updated: 'not a date', status: 'failed', chart: 'b-0.1.0', app_version: '' },
  ]);

  test('reads releases and drops entries that are not releases', () => {
    const releases = parseHelmList(output);
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({ name: 'a', namespace: 'x', chartName: 'a', chartVersion: '1.0.0', revision: 3, appVersion: '2.0', status: 'deployed', updated: '2026-11-12T16:23:27.000Z' });
    expect(releases[1]).toMatchObject({ name: 'b', updated: null, status: 'failed' });
  });

  test('bad JSON is an empty list', () => {
    expect(parseHelmList('Error: nope')).toEqual([]);
    expect(parseHelmList('{}')).toEqual([]);
    expect(parseHelmList('')).toEqual([]);
  });
});

describe('parseHelmHistory', () => {
  test('newest first, with the description', () => {
    const history = parseHelmHistory(JSON.stringify([
      { revision: 1, updated: '2026-01-01T00:00:00Z', status: 'superseded', chart: 'a-1.0.0', app_version: '1', description: 'Install complete' },
      { revision: 2, updated: '2026-01-02T00:00:00Z', status: 'deployed', chart: 'a-1.0.1', app_version: '1', description: 'Upgrade complete' },
    ]));
    expect(history.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(history[0]).toMatchObject({ status: 'deployed', description: 'Upgrade complete', chart: 'a-1.0.1' });
  });
});

describe('names that go to helm', () => {
  test('release names', () => {
    for (const ok of ['a', 'contracts', 'gitlab-runner-amd64', 'a.b']) expect(validReleaseName(ok)).toBe(true);
    for (const bad of ['', '-flag', '--set=x', 'Upper', 'a b', 'a;b', '../x', 'x'.repeat(54)]) expect(validReleaseName(bad)).toBe(false);
  });

  test('namespaces', () => {
    expect(validNamespaceName('kube-system')).toBe(true);
    for (const bad of ['', '-x', 'a.b', 'A', 'x'.repeat(64)]) expect(validNamespaceName(bad)).toBe(false);
  });

  test('chart references: repo/chart or oci, never a path, a URL or a flag', () => {
    for (const ok of ['bitnami/redis', 'my-repo/my.chart', 'oci://ghcr.io/org/charts/app']) expect(validChartRef(ok)).toBe(true);
    for (const bad of ['', './chart', '../chart', '/etc/chart', '-x/y', 'redis', 'https://x.example/chart.tgz', 'a/b/c', 'a b/c', 'oci://']) expect(validChartRef(bad)).toBe(false);
  });

  test('versions and revisions', () => {
    for (const ok of ['1.0.0', 'v1.2', '1.0.0-rc.1', '1.0.0+b5']) expect(validChartVersion(ok)).toBe(true);
    for (const bad of ['', '-1', '1 0', '1;2']) expect(validChartVersion(bad)).toBe(false);
    expect(validRevision(3)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(validRevision(bad)).toBe(false);
  });

  test('chart file paths stay inside the chart folder', () => {
    for (const ok of ['templates/a.yaml', 'values.yaml', '.gitignore', 'files/a/b.txt']) expect(safeChartPath(ok)).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'a\0b']) expect(safeChartPath(bad)).toBe(false);
  });
});

describe('repoCandidates', () => {
  test('only a repo with this exact version counts, in repo order', () => {
    const found = repoCandidates('redis', '18.1.0', [
      { repo: 'zeta', results: [{ name: 'zeta/redis', version: '18.1.0' }] },
      { repo: 'bitnami', results: [{ name: 'bitnami/redis', version: '18.1.0' }, { name: 'bitnami/redis', version: '19.0.0' }] },
      { repo: 'other', results: [{ name: 'other/redis', version: '17.0.0' }] },
      { repo: 'lookalike', results: [{ name: 'lookalike/redis-cluster', version: '18.1.0' }] },
    ]);
    expect(found).toEqual([
      { ref: 'bitnami/redis', version: '18.1.0' },
      { ref: 'zeta/redis', version: '18.1.0' },
    ]);
  });

  test('a v prefix does not matter and a missing version finds nothing', () => {
    expect(repoCandidates('x', 'v1.0.0', [{ repo: 'r', results: [{ name: 'r/x', version: '1.0.0' }] }])).toHaveLength(1);
    expect(repoCandidates('x', '', [{ repo: 'r', results: [{ name: 'r/x', version: '1.0.0' }] }])).toEqual([]);
  });
});

describe('releases in the table', () => {
  const releases = parseHelmList(JSON.stringify([
    { name: 'b-app', namespace: 'prod', revision: '4', updated: '2026-11-12T10:00:00Z', status: 'failed', chart: 'b-1.2.3', app_version: 'v9' },
    { name: 'a-app', namespace: 'dev', revision: '12', updated: '2026-11-11T10:00:00Z', status: 'deployed', chart: 'a-0.1.0', app_version: '' },
  ])).map(releaseObject);

  test('has the plan columns in order', () => {
    expect(HELM_VIEW.columns.map((column) => column.label)).toEqual(['Name', 'Namespace', 'Chart', 'Revision', 'Version', 'App version', 'Status', 'Updated']);
  });

  test('cells read from the release', () => {
    const [b] = releases;
    const text = (id: string): string => cellText(HELM_VIEW.columns.find((column) => column.id === id)!, b!, Date.parse('2026-11-12T12:00:00Z'));
    expect(text('name')).toBe('b-app');
    expect(text('chart')).toBe('b');
    expect(text('version')).toBe('1.2.3');
    expect(text('revision')).toBe('4');
    expect(text('appVersion')).toBe('v9');
    expect(text('status')).toBe('Failed');
    expect(text('updated')).toBe('120m');
  });

  test('sorts by revision as a number and searches the text', () => {
    expect(sortRows(releases, HELM_VIEW, 'revision', 'desc').map((o) => o.metadata.name)).toEqual(['a-app', 'b-app']);
    expect(rowText(HELM_VIEW, releases[0]!)).toContain('b-app');
    expect(rowText(HELM_VIEW, releases[0]!)).toContain('failed');
  });

  test('status tones', () => {
    expect(statusOf(HELM_VIEW, releases[0]!)).toEqual({ label: 'Failed', tone: 'error' });
    expect(helmStatus('deployed').tone).toBe('success');
    expect(helmStatus('pending-upgrade')).toEqual({ label: 'Pending upgrade', tone: 'info' });
    expect(helmStatus('superseded').tone).toBe('muted');
    expect(helmStatus('').label).toBe('Unknown');
  });
});

describe('the release record', () => {
  const chart = {
    metadata: { name: 'app', version: '1.0.0', apiVersion: 'v2', appVersion: '2' },
    templates: [{ name: 'templates/deploy.yaml', data: Buffer.from('kind: Deployment\n').toString('base64') }],
    values: { replicas: 2 },
    schema: Buffer.from('{"type":"object"}').toString('base64'),
    files: [{ name: '.gitignore', data: Buffer.from('x\n').toString('base64') }],
  };
  const record = { name: 'app', chart };
  const helmLayer = Buffer.from(gzipSync(Buffer.from(JSON.stringify(record)))).toString('base64');

  test('decodes the Secret layout (two base64 layers) and the ConfigMap layout (one)', () => {
    expect(decodeRecord(Buffer.from(helmLayer).toString('base64'), 2)).toEqual(record);
    expect(decodeRecord(helmLayer, 1)).toEqual(record);
  });

  test('an unreadable record is an error, not a crash', () => {
    expect(() => decodeRecord('%%%', 2)).toThrow(K8sError);
    expect(() => decodeRecord(Buffer.from('not json').toString('base64'), 1)).toThrow(K8sError);
  });

  test('rebuilds the chart files', () => {
    const files = Object.fromEntries(chartFiles(chart).map((file) => [file.path, file.data.toString('utf8')]));
    expect(Object.keys(files).sort()).toEqual(['.gitignore', 'Chart.yaml', 'templates/deploy.yaml', 'values.schema.json', 'values.yaml']);
    expect(files['templates/deploy.yaml']).toBe('kind: Deployment\n');
    expect(files['values.yaml']).toBe(stringify({ replicas: 2 }));
    expect(files['Chart.yaml']).toContain('name: app');
  });

  test('refuses a file name that could leave the chart folder', () => {
    for (const name of ['../evil', '/etc/x', 'templates/../../x']) {
      expect(() => chartFiles({ ...chart, templates: [{ name, data: '' }] })).toThrow(K8sError);
    }
  });

  test('a chart with subcharts in its metadata or only in its lock cannot be rebuilt', () => {
    expect(rebuildProblem({ chart })).toBeNull();
    expect(rebuildProblem({ chart: { ...chart, metadata: { ...chart.metadata, dependencies: [{ name: 'sub' }] } } })).toContain('subcharts');
    expect(rebuildProblem({ chart: { ...chart, lock: { dependencies: [{ name: 'sub' }] } } })).toContain('subcharts');
    expect(rebuildProblem({ chart: { ...chart, lock: { dependencies: [] } } })).toBeNull();
    expect(rebuildProblem({ chart: { metadata: { name: 'x' } } })).toContain('incomplete');
    expect(rebuildProblem({})).toContain('incomplete');
  });
});

describe('helmError', () => {
  test('maps helm words to codes', () => {
    expect(helmError('Error: release: not found').code).toBe('NOT_FOUND');
    expect(helmError('Error: another operation (install/upgrade/rollback) is in progress').code).toBe('CONFLICT');
    expect(helmError('secrets is forbidden: User "x" cannot list resource "secrets"').code).toBe('FORBIDDEN');
    expect(helmError('Error: Kubernetes cluster unreachable: Get "https://x": dial tcp 10.0.0.1:443: i/o timeout').code).toBe('UNREACHABLE');
    expect(helmError('Error: Token has expired').code).toBe('AUTH_EXPIRED');
    expect(helmError('Error: something odd').code).toBe('K8S_ERROR');
    expect(helmError('', true).message).toContain('too long');
  });
});

// The helm program is replaced by a function that records its arguments.
describe('commands sent to helm', () => {
  const calls: string[][] = [];
  const target = { context: 'ctx' };

  const fake = (answers: Array<{ match: (args: string[]) => boolean; stdout?: string; code?: number; stderr?: string }>): void => {
    calls.length = 0;
    setHelmRunner(async (args) => {
      calls.push(args);
      const answer = answers.find((candidate) => candidate.match(args));
      return { code: answer?.code ?? 0, stdout: answer?.stdout ?? '', stderr: answer?.stderr ?? '' };
    });
  };

  afterEach(() => setHelmRunner(null));

  const history = JSON.stringify([
    { revision: 2, updated: '2026-01-02T00:00:00Z', status: 'deployed', chart: 'app-1.0.0', app_version: '1', description: 'Upgrade complete' },
    { revision: 1, updated: '2026-01-01T00:00:00Z', status: 'superseded', chart: 'app-1.0.0', app_version: '1', description: 'Install complete' },
  ]);
  const manifest = (image: string): string => `---\n# Source: app/templates/deploy.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  image: ${image}\n---\n# Source: app/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\ndata:\n  password: c3VwZXItc2VjcmV0\n`;
  const is = (...words: string[]) => (args: string[]): boolean => words.every((word, index) => args[index] === word);

  test('list asks for every state, in JSON, for one namespace or all', async () => {
    fake([{ match: is('list'), stdout: '[]' }]);
    await listReleases(target, null);
    expect(calls[0]).toContain('--all-namespaces');
    expect(calls[0]).toContain('--failed');
    expect(calls[0]).toContain('--uninstalling');
    expect(calls[0]!.slice(-2)).toEqual(['--kube-context', 'ctx']);
    await listReleases(target, 'prod');
    expect(calls[1]).not.toContain('--all-namespaces');
    expect(calls[1]!.join(' ')).toContain('--namespace prod');
  });

  test('a kubeconfig the project named is passed on', async () => {
    fake([{ match: is('list'), stdout: '[]' }]);
    await listReleases({ context: 'ctx', kubeconfig: '/tmp/kc' }, null);
    expect(calls[0]!.join(' ')).toContain('--kubeconfig /tmp/kc');
  });

  test('values and manifests reach the caller hidden', async () => {
    fake([
      { match: is('get', 'values'), stdout: JSON.stringify({ db: { password: 'hunter2', host: 'db.local' } }) },
      { match: is('get', 'manifest'), stdout: manifest('web:1') },
    ]);
    const values = (await panelValues(target, 'prod', 'app')) as { db: Record<string, string> };
    expect(values.db).toEqual({ password: REDACTED, host: 'db.local' });
    const shown = await panelManifest(target, 'prod', 'app');
    expect(shown.secrets).toBe(1);
    expect(shown.manifest).not.toContain('c3VwZXItc2VjcmV0');
    expect(shown.resources).toEqual(['Deployment/web', 'Secret/creds']);
  });

  test('refuses a bad name before it reaches helm', async () => {
    fake([]);
    await expect(panelValues(target, 'prod', '--set=x')).rejects.toThrow(K8sError);
    await expect(panelManifest(target, 'Bad_NS', 'app')).rejects.toThrow(K8sError);
    expect(calls).toHaveLength(0);
  });

  test('rollback: a dry run changes nothing and shows the diff, a real run goes to helm', async () => {
    fake([
      { match: is('history'), stdout: history },
      { match: (args) => args[0] === 'get' && args[1] === 'manifest' && args.includes('--revision'), stdout: manifest('web:1') },
      { match: (args) => args[0] === 'get' && args[1] === 'manifest', stdout: manifest('web:2') },
    ]);
    const dry = await rollbackRelease(target, 'prod', 'app', 1, true);
    expect(calls.find((args) => args[0] === 'rollback')).toEqual(expect.arrayContaining(['rollback', 'app', '1', '--dry-run=server']));
    expect(dry.diff?.changed.map((change) => change.key)).toEqual(['Deployment/web']);
    expect(JSON.stringify(dry.diff)).not.toContain('c3VwZXItc2VjcmV0');
    calls.length = 0;
    await rollbackRelease(target, 'prod', 'app', 1, false);
    const real = calls.find((args) => args[0] === 'rollback')!;
    expect(real).not.toContain('--dry-run=server');
    expect(real).toContain('--timeout');
  });

  test('rollback refuses the current revision and one that is gone', async () => {
    fake([{ match: is('history'), stdout: history }]);
    await expect(rollbackRelease(target, 'prod', 'app', 2, false)).rejects.toThrow('already the current');
    await expect(rollbackRelease(target, 'prod', 'app', 9, false)).rejects.toThrow('no longer in the history');
    expect(calls.some((args) => args[0] === 'rollback')).toBe(false);
  });

  test('uninstall lists what goes, and a dry run passes --dry-run', async () => {
    fake([{ match: is('get', 'manifest'), stdout: manifest('web:1') }]);
    const result = await uninstallRelease(target, 'prod', 'app', { keepHistory: true, dryRun: true });
    expect(result.resources).toEqual(['Deployment/web', 'Secret/creds']);
    expect(calls.find((args) => args[0] === 'uninstall')).toEqual(expect.arrayContaining(['uninstall', 'app', '--keep-history', '--dry-run']));
    await uninstallRelease(target, 'prod', 'app', { keepHistory: false, dryRun: false });
    const real = calls.filter((args) => args[0] === 'uninstall')[1]!;
    expect(real).not.toContain('--dry-run');
    expect(real).not.toContain('--keep-history');
  });

  test('upgrade puts hidden values back, never writes the placeholder, and refuses when the release moved', async () => {
    let written = '';
    fake([
      { match: is('history'), stdout: history },
      { match: is('get', 'values'), stdout: JSON.stringify({ db: { password: 'hunter2' }, replicas: 1 }) },
      { match: is('get', 'manifest'), stdout: manifest('web:1') },
    ]);
    setHelmRunner(async (args) => {
      calls.push(args);
      if (args[0] === 'history') return { code: 0, stdout: history, stderr: '' };
      if (args[0] === 'get' && args[1] === 'values') return { code: 0, stdout: JSON.stringify({ db: { password: 'hunter2' }, replicas: 1 }), stderr: '' };
      if (args[0] === 'get' && args[1] === 'manifest') return { code: 0, stdout: manifest('web:1'), stderr: '' };
      if (args[0] === 'upgrade') {
        written = await Bun.file(args[args.indexOf('--values') + 1]!).text();
        return { code: 0, stdout: JSON.stringify({ manifest: manifest('web:2'), chart: { metadata: { version: '1.0.0' } } }), stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    });
    const result = await upgradeRelease(target, 'prod', 'app', { valuesText: `db:\n  password: ${REDACTED}\nreplicas: 3\n`, chart: 'oci://ghcr.io/org/app', version: '1.0.0', dryRun: true, expectedRevision: 2 });
    expect(written).toContain('password: hunter2');
    expect(written).not.toContain(REDACTED);
    expect(result.diff?.changed.map((change) => change.key)).toEqual(['Deployment/web']);
    const upgrade = calls.find((args) => args[0] === 'upgrade')!;
    expect(upgrade).toEqual(expect.arrayContaining(['upgrade', 'app', 'oci://ghcr.io/org/app', '--reset-values', '--dry-run=server', '--version', '1.0.0']));
    expect(JSON.stringify(result)).not.toContain('hunter2');
    await expect(upgradeRelease(target, 'prod', 'app', { valuesText: '{}', chart: 'oci://ghcr.io/org/app', dryRun: true, expectedRevision: 1 })).rejects.toThrow('moved from revision 1 to 2');
    await expect(upgradeRelease(target, 'prod', 'app', { valuesText: `token: ${REDACTED}`, chart: 'oci://ghcr.io/org/app', dryRun: true })).rejects.toThrow('could not be put back');
  });

  test('upgrade removes its temporary files, also when helm fails', async () => {
    let valuesFile = '';
    setHelmRunner(async (args) => {
      if (args[0] === 'history') return { code: 0, stdout: history, stderr: '' };
      if (args[0] === 'get') return { code: 0, stdout: args[1] === 'values' ? '{}' : manifest('web:1'), stderr: '' };
      valuesFile = args[args.indexOf('--values') + 1]!;
      return { code: 1, stdout: '', stderr: 'Error: UPGRADE FAILED: boom' };
    });
    await expect(upgradeRelease(target, 'prod', 'app', { valuesText: 'a: 1', chart: 'oci://ghcr.io/org/app', dryRun: false })).rejects.toThrow('boom');
    expect(valuesFile).not.toBe('');
    expect(await Bun.file(valuesFile).exists()).toBe(false);
  });

  test('upgrade refuses a chart that is a path or a URL', async () => {
    fake([{ match: is('history'), stdout: history }, { match: is('get', 'values'), stdout: '{}' }]);
    for (const chart of ['./local', '/abs/chart', 'https://x.example/c.tgz', '--set=x']) {
      await expect(upgradeRelease(target, 'prod', 'app', { valuesText: '{}', chart, dryRun: true })).rejects.toThrow(K8sError);
    }
    expect(calls.some((args) => args[0] === 'upgrade')).toBe(false);
  });
});
