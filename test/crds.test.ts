import { describe, expect, test } from 'bun:test';
import { buildNav, conditionStatus, stateTone, crdView, crId, crTitle, crWatchKind, entriesFromCrds, isCrKind, printerColumns, viewForCrd, type CrdEntry } from '../src/shared/crds.ts';
import { gitopsFamily, gitopsView, shortRevision } from '../src/shared/gitops.ts';
import { cellText, NAV, rowText, sortRows, statusOf } from '../src/shared/kinds.ts';
import type { Obj } from '../src/shared/types.ts';

const entry = (over: Partial<CrdEntry> = {}): CrdEntry => ({
  group: 'external-secrets.io',
  kind: 'ExternalSecret',
  plural: 'externalsecrets',
  singular: 'externalsecret',
  shortNames: ['es'],
  scope: 'Namespaced',
  version: 'v1',
  versions: ['v1'],
  columns: [],
  conditions: true,
  ...over,
});

const crd = (over: Obj = {}): Obj => ({
  metadata: { name: 'externalsecrets.external-secrets.io' },
  spec: {
    group: 'external-secrets.io',
    scope: 'Namespaced',
    names: { kind: 'ExternalSecret', plural: 'externalsecrets', singular: 'externalsecret', shortNames: ['es'] },
    versions: [
      { name: 'v1beta1', served: true, storage: false, additionalPrinterColumns: [{ name: 'Old', type: 'string', jsonPath: '.spec.old' }] },
      {
        name: 'v1',
        served: true,
        storage: true,
        schema: { openAPIV3Schema: { properties: { status: { properties: { conditions: { type: 'array' } } } } } },
        additionalPrinterColumns: [
          { name: 'Store', type: 'string', jsonPath: '.spec.secretStoreRef.name' },
          { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status', priority: 0 },
          { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
        ],
      },
      { name: 'v1alpha1', served: false, storage: false },
    ],
  },
  status: { conditions: [{ type: 'Established', status: 'True' }] },
  ...over,
});

describe('entriesFromCrds', () => {
  test('takes the printer columns of the version the cluster serves', () => {
    const [first] = entriesFromCrds([crd()], () => 'v1beta1');
    expect(first!.version).toBe('v1beta1');
    expect(first!.columns.map((column) => column.name)).toEqual(['Old']);
    const [second] = entriesFromCrds([crd()], () => 'v1');
    expect(second!.columns.map((column) => column.name)).toEqual(['Store', 'Ready', 'Age']);
    expect(second!.versions).toEqual(['v1beta1', 'v1']);
    expect(second!.conditions).toBe(true);
    expect(second!.shortNames).toEqual(['es']);
  });

  test('falls back to the storage version when discovery has no answer', () => {
    expect(entriesFromCrds([crd()], () => undefined)[0]!.version).toBe('v1');
  });

  test('leaves out a CRD that is not established, one with no served version, and broken entries', () => {
    const notReady = crd({ status: { conditions: [{ type: 'Established', status: 'False' }] } });
    const noneServed = crd({ spec: { ...crd().spec, versions: [{ name: 'v1', served: false }] } });
    expect(entriesFromCrds([notReady, noneServed, {}, { spec: { names: {} } }], () => 'v1')).toEqual([]);
  });

  test('a cluster scoped CRD', () => {
    const cluster = crd({ spec: { ...crd().spec, scope: 'Cluster' } });
    expect(entriesFromCrds([cluster], () => 'v1')[0]!.scope).toBe('Cluster');
  });
});

describe('ids and titles', () => {
  test('a custom resource id round-trips to the service kind', () => {
    expect(crId(entry())).toBe('cr:externalsecrets.external-secrets.io');
    expect(crWatchKind(crId(entry()))).toBe('externalsecrets.external-secrets.io');
    expect(isCrKind('cr:x.y')).toBe(true);
    expect(isCrKind('Pod')).toBe(false);
  });

  test('titles follow the Kind and the plural', () => {
    expect(crTitle({ kind: 'ExternalSecret', plural: 'externalsecrets' })).toBe('ExternalSecrets');
    expect(crTitle({ kind: 'Policy', plural: 'policies' })).toBe('Policies');
    expect(crTitle({ kind: 'SecurityGroupPolicy', plural: 'securitygrouppolicies' })).toBe('SecurityGroupPolicies');
    expect(crTitle({ kind: 'Ingress', plural: 'ingresses' })).toBe('Ingresses');
    expect(crTitle({ kind: 'Widget', plural: 'gadgets' })).toBe('Gadgets');
    expect(crTitle({ kind: 'Endpoints', plural: 'endpoints' })).toBe('Endpoints');
  });
});

describe('the table of a custom resource', () => {
  const columns = [
    { name: 'Store', type: 'string', jsonPath: '.spec.secretStoreRef.name', description: 'The store', priority: 0 },
    { name: 'Replicas', type: 'integer', jsonPath: '.spec.replicas', description: '', priority: 0 },
    { name: 'Wide', type: 'string', jsonPath: '.spec.wide', description: '', priority: 1 },
    { name: 'Synced', type: 'date', jsonPath: '.status.syncedAt', description: '', priority: 0 },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp', description: '', priority: 0 },
    { name: 'Name', type: 'string', jsonPath: '.metadata.name', description: '', priority: 0 },
  ];
  const view = crdView(entry({ columns, conditions: false }));
  const object: Obj = {
    metadata: { name: 'db', namespace: 'prod', creationTimestamp: '2026-11-12T10:00:00Z' },
    spec: { secretStoreRef: { name: 'aws' }, replicas: 3, wide: 'extra' },
    status: { syncedAt: '2026-11-12T11:00:00Z' },
  };

  test('Name, Namespace, the declared columns (wide ones last), then Age', () => {
    expect(view.columns.map((column) => column.label)).toEqual(['Name', 'Namespace', 'Store', 'Replicas', 'Synced', 'Wide', 'Age']);
    expect(view.title).toBe('ExternalSecrets');
  });

  test('a cluster scoped kind has no Namespace column', () => {
    expect(crdView(entry({ scope: 'Cluster', columns })).columns.map((column) => column.label)).not.toContain('Namespace');
  });

  test('cells read from the declared JSONPath', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const text = (label: string): string => cellText(view.columns.find((column) => column.label === label)!, object, now);
    expect(text('Store')).toBe('aws');
    expect(text('Replicas')).toBe('3');
    expect(text('Wide')).toBe('extra');
    expect(text('Synced')).toBe('60m');
    expect(text('Age')).toBe('120m');
  });

  test('numbers sort as numbers and a missing value goes last', () => {
    const rows: Obj[] = [{ metadata: { name: 'a' }, spec: { replicas: 10 } }, { metadata: { name: 'b' }, spec: { replicas: 9 } }, { metadata: { name: 'c' }, spec: {} }];
    const id = view.columns.find((column) => column.label === 'Replicas')!.id;
    expect(sortRows(rows, view, id, 'asc').map((row) => row.metadata.name)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, view, id, 'desc').map((row) => row.metadata.name)).toEqual(['a', 'b', 'c']);
  });

  test('search reads the declared columns', () => {
    expect(rowText(view, object)).toContain('aws');
  });

  test('a Status column appears when the CRD has conditions and no ready-like column of its own', () => {
    const withStatus = crdView(entry({ columns: [columns[0]!], conditions: true }));
    expect(withStatus.columns.map((column) => column.label)).toEqual(['Name', 'Namespace', 'Store', 'Status', 'Age']);
    const alreadyReady = crdView(entry({ columns: [{ name: 'Ready', type: 'string', jsonPath: '.status.ready', description: '', priority: 0 }], conditions: true }));
    expect(alreadyReady.columns.map((column) => column.label)).toEqual(['Name', 'Namespace', 'Ready', 'Age']);
    expect(statusOf(withStatus, { status: { conditions: [{ type: 'Ready', status: 'True' }] } })).toEqual({ label: 'Ready', tone: 'success' });
  });

  test('keeps at most eight declared columns', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `C${i}`, type: 'string', jsonPath: `.spec.c${i}`, description: '', priority: 0 }));
    expect(printerColumns({ columns: many })).toHaveLength(8);
  });

  test('a CRD with no printer columns still gets a usable table', () => {
    expect(crdView(entry({ columns: [], conditions: false })).columns.map((column) => column.label)).toEqual(['Name', 'Namespace', 'Age']);
  });
});

describe('state columns', () => {
  test('a Ready or Status printer column gets a dot for the usual words', () => {
    const view = crdView(entry({ columns: [{ name: 'Ready', type: 'string', jsonPath: '.status.ready', description: '', priority: 0 }, { name: 'Store', type: 'string', jsonPath: '.spec.s', description: '', priority: 0 }], conditions: false }));
    const ready = view.columns.find((column) => column.label === 'Ready')!;
    expect(ready.cell).toBe('tone');
    expect(ready.tone!({ status: { ready: 'True' } })).toBe('success');
    expect(ready.tone!({ status: { ready: 'False' } })).toBe('error');
    expect(ready.tone!({ status: { ready: 'Pending' } })).toBe('warning');
    expect(ready.tone!({ status: { ready: 'whatever' } })).toBeNull();
    expect(ready.tone!({})).toBeNull();
    expect(view.columns.find((column) => column.label === 'Store')!.cell).toBeUndefined();
  });

  test('stateTone', () => {
    expect(stateTone('Healthy')).toBe('success');
    expect(stateTone('Degraded')).toBe('error');
    expect(stateTone('Progressing')).toBe('warning');
    expect(stateTone('')).toBeNull();
  });
});

describe('conditionStatus', () => {
  const status = (conditions: Obj[]) => conditionStatus({ status: { conditions } });
  test('reads the usual readiness conditions', () => {
    expect(status([{ type: 'Ready', status: 'True' }])).toEqual({ label: 'Ready', tone: 'success' });
    expect(status([{ type: 'Ready', status: 'False' }])).toEqual({ label: 'Not ready', tone: 'error' });
    expect(status([{ type: 'Available', status: 'False' }])).toEqual({ label: 'Not available', tone: 'error' });
    expect(status([{ type: 'Ready', status: 'Unknown' }])).toEqual({ label: 'Unknown', tone: 'warning' });
    expect(status([{ type: 'Ready', status: 'True' }, { type: 'Stalled', status: 'True' }])).toEqual({ label: 'Stalled', tone: 'error' });
  });
  test('null when there is nothing to read', () => {
    expect(conditionStatus({})).toBeNull();
    expect(status([{ type: 'Custom', status: 'True' }])).toBeNull();
  });
});

describe('navigation', () => {
  const crds = [
    entry(),
    entry({ kind: 'SecretStore', plural: 'secretstores' }),
    entry({ group: 'openebs.io', kind: 'BlockDevice', plural: 'blockdevices' }),
    entry({ group: 'kustomize.toolkit.fluxcd.io', kind: 'Kustomization', plural: 'kustomizations' }),
    entry({ group: 'source.toolkit.fluxcd.io', kind: 'GitRepository', plural: 'gitrepositories' }),
    entry({ group: 'argoproj.io', kind: 'Application', plural: 'applications' }),
    entry({ group: 'argoproj.io', kind: 'Rollout', plural: 'rollouts' }),
  ];

  test('with no CRDs it is the fixed navigation', () => {
    expect(buildNav([])).toEqual(NAV);
  });

  test('Lens order: Events, Helm, Access control, Custom resources', () => {
    const ids = buildNav([]).map((section) => section.id);
    expect(ids.indexOf('helm')).toBe(ids.indexOf('events') + 1);
    expect(ids.indexOf('access')).toBe(ids.indexOf('helm') + 1);
    expect(ids.indexOf('crds')).toBe(ids.indexOf('access') + 1);
    expect(ids[ids.length - 1]).toBe('forwards');
  });

  test('one section per API group after Definitions, with one entry per CRD', () => {
    const nav = buildNav(crds);
    const ids = nav.map((section) => section.id);
    expect(ids.slice(ids.indexOf('crds'), ids.indexOf('crds') + 4)).toEqual(['crds', 'crd:argoproj.io', 'crd:external-secrets.io', 'crd:openebs.io']);
    expect(nav.find((section) => section.id === 'crd:external-secrets.io')!.items).toEqual([
      { kind: 'cr:externalsecrets.external-secrets.io', title: 'ExternalSecrets' },
      { kind: 'cr:secretstores.external-secrets.io', title: 'SecretStores' },
    ]);
  });

  test('Flux and Argo CD kinds sit in their GitOps sections, not under their group', () => {
    const nav = buildNav(crds);
    expect(nav.find((section) => section.id === 'gitops-flux')!.items.map((item) => item.title)).toEqual(['Kustomizations', 'GitRepositories']);
    expect(nav.find((section) => section.id === 'gitops-argo')!.items.map((item) => item.title)).toEqual(['Applications']);
    expect(nav.find((section) => section.id === 'crd:argoproj.io')!.items.map((item) => item.title)).toEqual(['Rollouts']);
    expect(nav.some((section) => section.id === 'crd:kustomize.toolkit.fluxcd.io')).toBe(false);
    const ids = nav.map((section) => section.id);
    expect(ids.indexOf('gitops-flux')).toBeGreaterThan(ids.indexOf('crd:openebs.io'));
    expect(ids.indexOf('gitops-argo')).toBe(ids.indexOf('gitops-flux') + 1);
    expect(ids[ids.length - 1]).toBe('forwards');
  });

  test('GitOps sections are absent when their CRDs are', () => {
    const ids = buildNav([entry()]).map((section) => section.id);
    expect(ids).not.toContain('gitops-flux');
    expect(ids).not.toContain('gitops-argo');
  });

  test('every entry id is unique', () => {
    const items = buildNav(crds).flatMap((section) => section.items.map((item) => item.kind));
    expect(new Set(items).size).toBe(items.length);
  });
});

describe('GitOps views', () => {
  test('which kinds belong', () => {
    expect(gitopsFamily('kustomize.toolkit.fluxcd.io', 'Kustomization')).toBe('flux');
    expect(gitopsFamily('argoproj.io', 'Application')).toBe('argo');
    expect(gitopsFamily('argoproj.io', 'Rollout')).toBeNull();
    expect(gitopsView('argoproj.io', 'Rollout')).toBeNull();
  });

  test('revisions are shortened', () => {
    expect(shortRevision('main@sha1:2f1d6ab4c9e0112233445566778899aabbccddee')).toBe('main@sha1:2f1d6ab');
    expect(shortRevision('main/2f1d6ab4c9e0112233445566778899aabbccddee')).toBe('main/2f1d6ab4c9e0112233445566778899aabbccddee');
    expect(shortRevision('2f1d6ab4c9e0112233445566778899aabbccddee')).toBe('2f1d6ab');
    expect(shortRevision('1.2.3')).toBe('1.2.3');
  });

  const NOW = Date.parse('2026-11-12T12:00:00Z');

  describe('Flux', () => {
    const kustomization = (over: Obj = {}): Obj => ({
      apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
      kind: 'Kustomization',
      metadata: { name: 'apps', namespace: 'flux-system', creationTimestamp: '2026-11-01T00:00:00Z' },
      spec: { sourceRef: { kind: 'GitRepository', name: 'fleet' }, path: './apps', interval: '10m' },
      status: {
        lastAppliedRevision: 'main@sha1:2f1d6ab4c9e0112233445566778899aabbccddee',
        lastHandledReconcileAt: '2026-11-12T11:30:00Z',
        conditions: [{ type: 'Ready', status: 'True', message: 'Applied revision: main@sha1:2f1d6ab', lastTransitionTime: '2026-11-10T00:00:00Z' }],
      },
      ...over,
    });
    const view = gitopsView('kustomize.toolkit.fluxcd.io', 'Kustomization')!;
    const cell = (object: Obj, id: string): string => cellText(view.columns.find((column) => column.id === id)!, object, NOW);

    test('Ready, revision, source, last reconcile and message', () => {
      const o = kustomization();
      expect(view.columns.map((column) => column.label)).toEqual(['Name', 'Namespace', 'Ready', 'Revision', 'Source', 'Last reconcile', 'Message', 'Age']);
      expect(cell(o, 'ready')).toBe('Ready');
      expect(cell(o, 'revision')).toBe('main@sha1:2f1d6ab');
      expect(cell(o, 'source')).toBe('GitRepository/fleet');
      expect(cell(o, 'reconciled')).toBe('30m');
      expect(cell(o, 'message')).toContain('Applied revision');
      expect(statusOf(view, o)).toEqual({ label: 'Ready', tone: 'success' });
    });

    test('not ready, reconciling, stalled, suspended and not yet reported', () => {
      const withReady = (status: string, extra: Obj[] = []): Obj => kustomization({ status: { conditions: [{ type: 'Ready', status, message: 'x' }, ...extra] } });
      expect(statusOf(view, withReady('False'))).toEqual({ label: 'Not ready', tone: 'error' });
      expect(statusOf(view, withReady('Unknown', [{ type: 'Reconciling', status: 'True' }]))).toEqual({ label: 'Reconciling', tone: 'info' });
      expect(statusOf(view, withReady('False', [{ type: 'Stalled', status: 'True' }]))).toEqual({ label: 'Stalled', tone: 'error' });
      expect(statusOf(view, kustomization({ spec: { suspend: true } }))).toEqual({ label: 'Suspended', tone: 'muted' });
      expect(statusOf(view, kustomization({ status: {} }))).toEqual({ label: 'Pending', tone: 'muted' });
      expect(cell(kustomization({ spec: { suspend: true } }), 'message')).toContain('Suspended');
    });

    test('HelmRelease and the source kinds', () => {
      const release = gitopsView('helm.toolkit.fluxcd.io', 'HelmRelease')!;
      const object: Obj = { kind: 'HelmRelease', metadata: { name: 'redis' }, spec: { chart: { spec: { chart: 'redis', sourceRef: { kind: 'HelmRepository', name: 'bitnami' } } } }, status: { history: [{ chartVersion: '18.1.0' }], conditions: [{ type: 'Ready', status: 'True' }] } };
      const text = (id: string): string => cellText(release.columns.find((column) => column.id === id)!, object, NOW);
      expect(text('source')).toBe('redis from HelmRepository/bitnami');
      expect(text('revision')).toBe('18.1.0');
      const git = gitopsView('source.toolkit.fluxcd.io', 'GitRepository')!;
      expect(git.columns.find((column) => column.id === 'source')!.label).toBe('URL');
      expect(cellText(git.columns.find((column) => column.id === 'source')!, { spec: { url: 'ssh://git@host/fleet' } }, NOW)).toBe('ssh://git@host/fleet');
      expect(cellText(git.columns.find((column) => column.id === 'revision')!, { status: { artifact: { revision: 'main@sha1:abcdef1234567890' } } }, NOW)).toBe('main@sha1:abcdef1');
    });
  });

  describe('Argo CD', () => {
    const application = (over: Obj = {}): Obj => ({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'web', namespace: 'argocd' },
      spec: { project: 'default', source: { repoURL: 'https://git/x', targetRevision: 'main' }, destination: { namespace: 'prod', server: 'https://kubernetes.default.svc' } },
      status: { sync: { status: 'Synced', revision: '2f1d6ab4c9e0112233445566778899aabbccddee' }, health: { status: 'Healthy' }, reconciledAt: '2026-11-12T11:55:00Z' },
      ...over,
    });
    const view = gitopsView('argoproj.io', 'Application')!;
    const col = (id: string) => view.columns.find((column) => column.id === id)!;

    test('Synced, Health, revision, last reconcile', () => {
      const o = application();
      expect(view.columns.map((column) => column.label)).toEqual(['Name', 'Namespace', 'Sync', 'Health', 'Revision', 'Target', 'Project', 'Destination', 'Last reconcile', 'Message']);
      expect(cellText(col('sync'), o, NOW)).toBe('Synced');
      expect(cellText(col('health'), o, NOW)).toBe('Healthy');
      expect(cellText(col('revision'), o, NOW)).toBe('2f1d6ab');
      expect(cellText(col('target'), o, NOW)).toBe('main');
      expect(cellText(col('destination'), o, NOW)).toBe('prod on kubernetes.default.svc');
      expect(cellText(col('reconciled'), o, NOW)).toBe('5m');
      expect(col('sync').tone!(o)).toBe('success');
      expect(col('health').tone!(o)).toBe('success');
      expect(col('sync').cell).toBe('tone');
    });

    test('tones and the header status', () => {
      const out = application({ status: { sync: { status: 'OutOfSync' }, health: { status: 'Degraded' }, operationState: { message: 'one or more objects failed to apply' } } });
      expect(col('sync').tone!(out)).toBe('warning');
      expect(col('health').tone!(out)).toBe('error');
      expect(statusOf(view, out)).toEqual({ label: 'Degraded', tone: 'error' });
      expect(statusOf(view, application({ status: { sync: { status: 'OutOfSync' }, health: { status: 'Healthy' } } }))).toEqual({ label: 'OutOfSync', tone: 'warning' });
      expect(statusOf(view, application({ status: { sync: { status: 'Synced' }, health: { status: 'Progressing' } } }))).toEqual({ label: 'Progressing', tone: 'info' });
      expect(statusOf(view, application({ status: {} }))).toBeNull();
      expect(cellText(col('message'), out, NOW)).toBe('one or more objects failed to apply');
    });

    test('ApplicationSet and AppProject', () => {
      const set = gitopsView('argoproj.io', 'ApplicationSet')!;
      const object: Obj = { metadata: { name: 'envs' }, spec: { generators: [{ list: {} }, { git: {} }] }, status: { applicationStatus: [{}, {}, {}], conditions: [{ type: 'ResourcesUpToDate', status: 'True' }] } };
      expect(cellText(set.columns.find((column) => column.id === 'generators')!, object, NOW)).toBe('list, git');
      expect(cellText(set.columns.find((column) => column.id === 'applications')!, object, NOW)).toBe('3');
      expect(statusOf(set, object)).toEqual({ label: 'Up to date', tone: 'success' });
      expect(statusOf(set, { status: { conditions: [{ type: 'ErrorOccurred', status: 'True' }] } })).toEqual({ label: 'Error', tone: 'error' });
      const project = gitopsView('argoproj.io', 'AppProject')!;
      expect(cellText(project.columns.find((column) => column.id === 'destinations')!, { spec: { destinations: [{}, {}] } }, NOW)).toBe('2');
    });
  });

  test('viewForCrd uses the curated view for GitOps and printer columns for the rest', () => {
    expect(viewForCrd(entry({ group: 'argoproj.io', kind: 'Application', plural: 'applications' })).title).toBe('Applications');
    expect(viewForCrd(entry({ columns: [{ name: 'Store', type: 'string', jsonPath: '.spec.a', description: '', priority: 0 }] })).columns.map((column) => column.label)).toContain('Store');
  });
});
