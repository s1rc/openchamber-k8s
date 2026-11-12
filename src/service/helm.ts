import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parse, stringify } from 'yaml';
import { diffManifests, manifestDocs, type ManifestDiff } from '../shared/diff.ts';
import {
  parseHelmHistory,
  parseHelmList,
  repoCandidates,
  safeChartPath,
  splitChart,
  validChartRef,
  validChartVersion,
  validNamespaceName,
  validReleaseName,
  validRevision,
  type ChartCandidate,
  type HelmHistoryEntry,
  type HelmRelease,
} from '../shared/helm.ts';
import { redactManifest, redactValues, restoreRedacted } from '../shared/redact.ts';
import type { Obj, Target } from '../shared/types.ts';
import { clip, fromOutput, K8sError } from './errors.ts';
import { findBin } from './bins.ts';
import { kubeconfigArgs, run, type RunResult } from './exec.ts';
import { callJson } from './k8s.ts';

// Helm releases through the helm program. Values and manifests can hold secrets, so everything that leaves this file
// for the panel goes through the redaction helpers first. The raw values and manifests stay inside these functions.

type Runner = (args: string[], options: { timeoutMs: number; maxBuffer: number }) => Promise<RunResult>;

const helmPath = (): string => {
  const found = findBin('helm');
  if (!found) throw new K8sError('NO_KUBECTL', 'helm was not found. Install it, for example with Homebrew (brew install helm), then try again.', { kind: 'install' });
  return found;
};

const defaultRunner: Runner = (args, options) => run(helmPath(), args, options);
let runner: Runner = defaultRunner;

/** Replaces the program runner, for tests. Pass null to restore it. */
export const setHelmRunner = (next: Runner | null): void => {
  runner = next ?? defaultRunner;
};

const TIME_FORMAT = '2006-01-02T15:04:05Z07:00';
const RELEASE_STATES = ['--deployed', '--failed', '--pending', '--superseded', '--uninstalled', '--uninstalling'];

/**
 * Helm 4 prints a log line (`level=WARN msg="upgrade failed" ... error="..."`) before its own `Error:` line. The `Error:` line
 * says the same thing without the noise, so it is used when there is one.
 */
export const cleanHelmOutput = (stderr: string): string => {
  const text = stderr.trim();
  const errorLine = text.split('\n').reverse().find((line) => line.startsWith('Error:'));
  return errorLine ? errorLine.replace(/^Error:\s*/, '') : text;
};

/** Reads helm's own words and says what kind of failure it is. */
export const helmError = (stderr: string, exitedEmpty = false, context?: string): K8sError => {
  const text = cleanHelmOutput(stderr);
  if (!text && exitedEmpty) return new K8sError('K8S_ERROR', 'Helm took too long to answer or was stopped.');
  if (/release: not found|release ".*" not found|no revision for release/i.test(text)) return new K8sError('NOT_FOUND', 'That release or revision was not found.');
  if (/another operation \(install\/upgrade\/rollback\) is in progress/i.test(text)) return new K8sError('CONFLICT', 'Another Helm change is running on this release. Try again when it has finished.');
  if (/\bforbidden\b|cannot (get|list|create|patch|update|delete) resource/i.test(text)) return new K8sError('FORBIDDEN', clip(text) || 'You are not allowed to do that here.');
  if (/cluster unreachable|kubernetes cluster unreachable/i.test(text) && !/unauthorized|token|sso|credentials/i.test(text)) return new K8sError('UNREACHABLE', 'The cluster is not reachable. Check your network or VPN.');
  return fromOutput(text, 'Helm did not finish.', context);
};

interface HelmCall {
  /** Adds `--namespace`. */
  namespace?: string | null;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Commands that do not talk to a cluster (repo list, search). */
  noCluster?: boolean;
}

const helm = async (target: Target, args: string[], options: HelmCall = {}): Promise<string> => {
  const full = options.noCluster ? args : [...args, '--kube-context', target.context, ...kubeconfigArgs(target.kubeconfig), ...(options.namespace ? ['--namespace', options.namespace] : [])];
  const result = await runner(full, { timeoutMs: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer ?? 64_000_000 });
  if (result.code !== 0) throw helmError(result.stderr || result.stdout, result.code === -1, target.context);
  return result.stdout;
};

const bad = (message: string): K8sError => new K8sError('BAD_REQUEST', message);

const checkNames = (namespace: string, name: string): void => {
  if (!validNamespaceName(namespace)) throw bad('That namespace name is not valid.');
  if (!validReleaseName(name)) throw bad('That release name is not valid.');
};

// ----- Reads

export const listReleases = async (target: Target, namespace: string | null): Promise<HelmRelease[]> => {
  if (namespace !== null && !validNamespaceName(namespace)) throw bad('That namespace name is not valid.');
  const out = await helm(target, ['list', ...(namespace ? [] : ['--all-namespaces']), '--max', '1000', ...RELEASE_STATES, '--output', 'json', '--time-format', TIME_FORMAT], { namespace, timeoutMs: 90_000 });
  return parseHelmList(out);
};

export const releaseHistory = async (target: Target, namespace: string, name: string, max = 256): Promise<HelmHistoryEntry[]> => {
  checkNames(namespace, name);
  return parseHelmHistory(await helm(target, ['history', name, '--max', String(max), '--output', 'json'], { namespace }));
};

/** The values as the cluster has them. Never returned to the panel as is. */
const rawValues = async (target: Target, namespace: string, name: string, options: { all?: boolean; revision?: number } = {}): Promise<Obj> => {
  const out = await helm(target, ['get', 'values', name, '--output', 'json', ...(options.all ? ['--all'] : []), ...(options.revision ? ['--revision', String(options.revision)] : [])], { namespace });
  try {
    const parsed = JSON.parse(out || 'null') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Obj) : {};
  } catch {
    throw new K8sError('K8S_ERROR', 'Helm answered something unreadable.');
  }
};

/** The release values with every secret-looking value hidden. */
export const panelValues = async (target: Target, namespace: string, name: string, options: { all?: boolean; revision?: number } = {}): Promise<Obj> => {
  checkNames(namespace, name);
  if (options.revision !== undefined && !validRevision(options.revision)) throw bad('That revision is not valid.');
  return redactValues(await rawValues(target, namespace, name, options)) as Obj;
};

const rawManifest = async (target: Target, namespace: string, name: string, revision?: number): Promise<string> =>
  helm(target, ['get', 'manifest', name, ...(revision ? ['--revision', String(revision)] : [])], { namespace });

export interface PanelManifest {
  manifest: string;
  /** How many Secret documents were hidden. */
  secrets: number;
  /** How many values that look like secrets were hidden in other objects (a password in a ConfigMap, an env var). */
  masked: number;
  /** `Kind/name`, one per document. */
  resources: string[];
}

/** The rendered manifest with every Secret document hidden. */
export const panelManifest = async (target: Target, namespace: string, name: string, revision?: number): Promise<PanelManifest> => {
  checkNames(namespace, name);
  if (revision !== undefined && !validRevision(revision)) throw bad('That revision is not valid.');
  const { text, secrets, masked } = redactManifest(await rawManifest(target, namespace, name, revision));
  return { manifest: text, secrets, masked, resources: manifestDocs(text).map((doc) => doc.key) };
};

// ----- The chart a release came from

interface ReleaseRecord {
  chart?: Obj;
}

const RECORD_MAX_BYTES = 30_000_000;

/** A release record as Helm stores it: base64 of gzipped JSON, inside the Secret's own base64 layer. A ConfigMap record has no outer layer. */
export const decodeRecord = (encoded: string, layers: 1 | 2): ReleaseRecord => {
  try {
    const inner = layers === 2 ? Buffer.from(encoded, 'base64').toString('utf8') : encoded;
    const bytes = Buffer.from(inner, 'base64');
    const json = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: RECORD_MAX_BYTES }) : bytes;
    return JSON.parse(json.toString('utf8')) as ReleaseRecord;
  } catch {
    throw new K8sError('K8S_ERROR', 'The release record could not be read.');
  }
};

const readRecord = async (target: Target, namespace: string, name: string, revision: number): Promise<ReleaseRecord> => {
  const id = `sh.helm.release.v1.${name}.v${revision}`;
  const base = `/api/v1/namespaces/${encodeURIComponent(namespace)}`;
  try {
    const secret = await callJson(target, { path: `${base}/secrets/${id}`, timeoutMs: 60_000 });
    if (typeof secret.data?.release === 'string') return decodeRecord(secret.data.release, 2);
  } catch (error) {
    if (!(error instanceof K8sError) || error.code !== 'NOT_FOUND') throw error;
  }
  try {
    const map = await callJson(target, { path: `${base}/configmaps/${id}`, timeoutMs: 60_000 });
    if (typeof map.data?.release === 'string') return decodeRecord(map.data.release, 1);
  } catch (error) {
    if (!(error instanceof K8sError) || error.code !== 'NOT_FOUND') throw error;
  }
  throw new K8sError('NOT_FOUND', 'The release record was not found. Helm may store releases somewhere other than Secrets.');
};

export interface ChartFile {
  path: string;
  data: Buffer;
}

const CHART_MAX_BYTES = 50_000_000;

/** Why a release cannot be rebuilt from its record, or null when it can. A record does not keep subcharts. */
export const rebuildProblem = (record: ReleaseRecord): string | null => {
  const chart = record.chart;
  const metadata = chart?.metadata as Obj | undefined;
  if (!chart || !metadata || typeof metadata.name !== 'string' || typeof metadata.version !== 'string') return 'The release record is incomplete.';
  // A chart can name its subcharts only in Chart.lock (helm drops them from the metadata), so both are read.
  const locked = (chart.lock as Obj | null | undefined)?.dependencies;
  if ((Array.isArray(metadata.dependencies) && metadata.dependencies.length > 0) || (Array.isArray(locked) && locked.length > 0)) {
    return 'This chart has subcharts, which a release does not keep. Pick the chart from a repository.';
  }
  if (metadata.type === 'library') return 'A library chart cannot be installed.';
  return null;
};

/** The files of the chart inside a release record. A name that could leave the chart folder is refused. */
export const chartFiles = (chart: Obj): ChartFile[] => {
  const files = new Map<string, Buffer>();
  let total = 0;
  const add = (path: unknown, data: Buffer): void => {
    if (typeof path !== 'string' || !safeChartPath(path)) throw new K8sError('INVALID', 'The release record holds a file name that is not safe to write.');
    total += data.length;
    if (total > CHART_MAX_BYTES) throw new K8sError('INVALID', 'The chart in the release record is too large to rebuild.');
    files.set(path, data);
  };
  const list = (value: unknown): Obj[] => (Array.isArray(value) ? (value as Obj[]) : []);
  for (const file of list(chart.templates)) add(file.name, Buffer.from(String(file.data ?? ''), 'base64'));
  for (const file of list(chart.files)) add(file.name, Buffer.from(String(file.data ?? ''), 'base64'));
  if (typeof chart.schema === 'string' && chart.schema) add('values.schema.json', Buffer.from(chart.schema, 'base64'));
  add('values.yaml', Buffer.from(stringify(chart.values ?? {}, { lineWidth: 0 })));
  add('Chart.yaml', Buffer.from(stringify(chart.metadata ?? {}, { lineWidth: 0 })));
  return [...files].map(([path, data]) => ({ path, data }));
};

const writeChart = async (dir: string, files: ChartFile[]): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = join(dir, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { mode: 0o600 });
  }
};

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const repoNames = async (): Promise<string[]> => {
  try {
    const out = await helm({ context: '' }, ['repo', 'list', '--output', 'json'], { noCluster: true, timeoutMs: 20_000 });
    const parsed = JSON.parse(out || '[]') as Array<{ name?: unknown }>;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry.name ?? '')).filter((entry) => REPO_NAME.test(entry)) : [];
  } catch {
    // No repositories added (helm exits with an error) or helm cannot read its config: nothing to match against.
    return [];
  }
};

export interface ChartSources {
  revision: number;
  chartName: string;
  chartVersion: string;
  /** Repositories holding this chart at exactly this version. */
  candidates: ChartCandidate[];
  rebuild: { ok: boolean; reason?: string };
  /** What an upgrade uses unless told otherwise. */
  default: 'repo' | 'release' | null;
  repos: string[];
}

/** Where an upgrade could get the chart: a repository that has this exact version, or the chart kept in the release record. */
export const chartSources = async (target: Target, namespace: string, name: string): Promise<ChartSources> => {
  checkNames(namespace, name);
  const current = (await releaseHistory(target, namespace, name, 1))[0];
  if (!current) throw new K8sError('NOT_FOUND', 'That release was not found.');
  const { name: chartName, version: chartVersion } = splitChart(current.chart);
  const repos = (await repoNames()).slice(0, 8);
  const searches = REPO_NAME.test(chartName)
    ? await Promise.all(
        repos.map(async (repo) => {
          try {
            const out = await helm(target, ['search', 'repo', `${repo}/${chartName}`, '--versions', '--output', 'json'], { noCluster: true, timeoutMs: 20_000 });
            const parsed = JSON.parse(out || '[]') as unknown;
            return { repo, results: Array.isArray(parsed) ? (parsed as Array<{ name?: unknown; version?: unknown }>) : [] };
          } catch {
            return { repo, results: [] };
          }
        }),
      )
    : [];
  const candidates = repoCandidates(chartName, chartVersion, searches);
  let rebuild: ChartSources['rebuild'];
  try {
    const problem = rebuildProblem(await readRecord(target, namespace, name, current.revision));
    rebuild = problem ? { ok: false, reason: problem } : { ok: true };
  } catch (error) {
    rebuild = { ok: false, reason: error instanceof K8sError ? error.message : 'The release record could not be read.' };
  }
  return { revision: current.revision, chartName, chartVersion, candidates, rebuild, default: candidates.length > 0 ? 'repo' : rebuild.ok ? 'release' : null, repos };
};

// ----- Changes

const parseValuesText = (text: string): Obj => {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new K8sError('INVALID', `The values are not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : 'check them again.'}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new K8sError('INVALID', 'The values must be a YAML mapping (keys and values).');
  return parsed as Obj;
};

export interface UpgradeRequest {
  valuesText: string;
  /** `repo/chart` or `oci://...`: use this chart instead of the default. */
  chart?: string;
  version?: string;
  /** Rebuild the chart from the release record. */
  fromRelease?: boolean;
  dryRun: boolean;
  /** The revision the check was made against; the change is refused when the release has moved on. */
  expectedRevision?: number;
}

export interface UpgradeResult {
  dryRun: boolean;
  revision: number;
  chart: { source: 'repo' | 'release'; ref: string; version: string };
  /** What the new manifest would change, with every Secret hidden. Only for a dry run. */
  diff?: ManifestDiff;
}

type ResolvedChart = { source: 'repo'; ref: string; version: string | null } | { source: 'release' };

const resolveChart = async (target: Target, namespace: string, name: string, request: UpgradeRequest): Promise<ResolvedChart> => {
  if (request.version !== undefined && !validChartVersion(request.version)) throw bad('That chart version is not valid.');
  if (request.fromRelease) return { source: 'release' };
  if (request.chart) {
    if (!validChartRef(request.chart)) throw bad('Name the chart as repo/chart or an oci:// address.');
    if (!request.chart.startsWith('oci://')) {
      const repo = request.chart.split('/')[0]!;
      if (!(await repoNames()).includes(repo)) throw bad(`The repository "${repo}" is not added to Helm. Add it with helm repo add, then try again.`);
    }
    return { source: 'repo', ref: request.chart, version: request.version ?? null };
  }
  const sources = await chartSources(target, namespace, name);
  const candidate = sources.candidates[0];
  if (candidate) return { source: 'repo', ref: candidate.ref, version: request.version ?? candidate.version };
  if (sources.rebuild.ok) return { source: 'release' };
  throw new K8sError('INVALID', sources.rebuild.reason ?? 'No chart was found for this release. Name one.');
};

const manifestFromDryRun = (output: string): { manifest: string; version: string } => {
  try {
    const parsed = JSON.parse(output) as { manifest?: unknown; chart?: { metadata?: { version?: unknown } } };
    return { manifest: typeof parsed.manifest === 'string' ? parsed.manifest : '', version: String(parsed.chart?.metadata?.version ?? '') };
  } catch {
    throw new K8sError('K8S_ERROR', 'Helm answered something unreadable.');
  }
};

/**
 * Upgrades a release with edited values. The values arrive as the panel showed them, with secret values hidden; a hidden
 * value is put back from the release before anything is written. A dry run asks the cluster to check the change and
 * answers with the manifest diff; the real run changes the release.
 */
export const upgradeRelease = async (target: Target, namespace: string, name: string, request: UpgradeRequest): Promise<UpgradeResult> => {
  checkNames(namespace, name);
  const current = (await releaseHistory(target, namespace, name, 1))[0];
  if (!current) throw new K8sError('NOT_FOUND', 'That release was not found.');
  if (request.expectedRevision !== undefined && current.revision !== request.expectedRevision) {
    throw new K8sError('CONFLICT', `The release moved from revision ${request.expectedRevision} to ${current.revision} since you checked. Check the change again.`);
  }
  const edited = parseValuesText(request.valuesText);
  const restored = restoreRedacted(edited, await rawValues(target, namespace, name));
  if (restored.unresolved.length > 0) {
    throw new K8sError('INVALID', `A hidden value could not be put back (${restored.unresolved.slice(0, 3).join(', ')}). Type the value again instead of <redacted>.`);
  }
  const resolved = await resolveChart(target, namespace, name, request);
  const dir = await mkdtemp(join(tmpdir(), 'k8s-helm-'));
  try {
    await chmod(dir, 0o700);
    const valuesFile = join(dir, 'values.yaml');
    await writeFile(valuesFile, stringify(restored.value ?? {}, { lineWidth: 0 }), { mode: 0o600 });
    let chartArg: string;
    let version: string | null = null;
    if (resolved.source === 'release') {
      const record = await readRecord(target, namespace, name, current.revision);
      const problem = rebuildProblem(record);
      if (problem) throw new K8sError('INVALID', problem);
      chartArg = join(dir, 'chart');
      await writeChart(chartArg, chartFiles(record.chart as Obj));
    } else {
      chartArg = resolved.ref;
      version = resolved.version;
    }
    const args = ['upgrade', name, chartArg, '--reset-values', '--values', valuesFile, ...(version ? ['--version', version] : []), ...(request.dryRun ? ['--dry-run=server', '--output', 'json'] : ['--timeout', '5m'])];
    const out = await helm(target, args, { namespace, timeoutMs: request.dryRun ? 180_000 : 330_000, maxBuffer: 128_000_000 });
    const chart = { source: resolved.source, ref: resolved.source === 'release' ? 'the release record' : resolved.ref, version: version ?? splitChart(current.chart).version };
    if (!request.dryRun) return { dryRun: false, revision: current.revision, chart };
    const proposed = manifestFromDryRun(out);
    const before = redactManifest(await rawManifest(target, namespace, name)).text;
    return { dryRun: true, revision: current.revision, chart: { ...chart, version: proposed.version || chart.version }, diff: diffManifests(before, redactManifest(proposed.manifest).text) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface RollbackResult {
  dryRun: boolean;
  revision: number;
  diff?: ManifestDiff;
}

export const rollbackRelease = async (target: Target, namespace: string, name: string, revision: number, dryRun: boolean): Promise<RollbackResult> => {
  checkNames(namespace, name);
  if (!validRevision(revision)) throw bad('Pick a revision to roll back to.');
  const history = await releaseHistory(target, namespace, name);
  if (!history.some((entry) => entry.revision === revision)) throw new K8sError('NOT_FOUND', `Revision ${revision} is no longer in the history.`);
  if (history[0]?.revision === revision) throw new K8sError('INVALID', `Revision ${revision} is already the current one.`);
  await helm(target, ['rollback', name, String(revision), ...(dryRun ? ['--dry-run=server'] : ['--timeout', '5m'])], { namespace, timeoutMs: dryRun ? 120_000 : 330_000 });
  if (!dryRun) return { dryRun, revision };
  const [now, then] = await Promise.all([rawManifest(target, namespace, name), rawManifest(target, namespace, name, revision)]);
  return { dryRun, revision, diff: diffManifests(redactManifest(now).text, redactManifest(then).text) };
};

export interface UninstallResult {
  dryRun: boolean;
  /** `Kind/name`, what the uninstall removes. */
  resources: string[];
}

export const uninstallRelease = async (target: Target, namespace: string, name: string, options: { keepHistory: boolean; dryRun: boolean }): Promise<UninstallResult> => {
  checkNames(namespace, name);
  const resources = manifestDocs(redactManifest(await rawManifest(target, namespace, name)).text).map((doc) => doc.key);
  await helm(target, ['uninstall', name, ...(options.keepHistory ? ['--keep-history'] : []), ...(options.dryRun ? ['--dry-run'] : ['--timeout', '5m'])], { namespace, timeoutMs: options.dryRun ? 60_000 : 330_000 });
  return { dryRun: options.dryRun, resources };
};
