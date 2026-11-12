// Helm releases as the panel shows them, and the checks the service runs before it hands anything to the helm program.
// Pure, so the table, the service and the tests agree.
import type { Column, KindView, StatusInfo } from './kinds.ts';
import type { Obj } from './types.ts';

export const HELM_RELEASES = 'HelmReleases';

export interface HelmRelease {
  name: string;
  namespace: string;
  /** `contracts-1.0.0`, as helm prints it. */
  chart: string;
  chartName: string;
  chartVersion: string;
  revision: number;
  appVersion: string;
  status: string;
  /** ISO time of the last revision, or null when helm printed none. */
  updated: string | null;
}

export interface HelmHistoryEntry {
  revision: number;
  updated: string | null;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/** `haproxy-ingress-0.14.10` becomes the chart name and its version. A chart with no version in its label keeps the whole text as the name. */
export const splitChart = (chart: string): { name: string; version: string } => {
  const match = /^(.+?)-(v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(chart);
  return match ? { name: match[1]!, version: match[2]! } : { name: chart, version: '' };
};

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/** The JSON of `helm list -o json`. Entries that are not releases are dropped. */
export const parseHelmList = (output: string): HelmRelease[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const releases: HelmRelease[] = [];
  for (const entry of parsed as Obj[]) {
    const name = text(entry?.name);
    const namespace = text(entry?.namespace);
    const revision = Number(entry?.revision);
    if (!name || !namespace || !Number.isInteger(revision)) continue;
    const chart = text(entry.chart);
    const { name: chartName, version: chartVersion } = splitChart(chart);
    releases.push({ name, namespace, chart, chartName, chartVersion, revision, appVersion: text(entry.app_version), status: text(entry.status) || 'unknown', updated: isoOrNull(entry.updated) });
  }
  return releases;
};

/** The JSON of `helm history -o json`, newest first. */
export const parseHelmHistory = (output: string): HelmHistoryEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as Obj[])
    .map((entry): HelmHistoryEntry | null => {
      const revision = Number(entry?.revision);
      if (!Number.isInteger(revision)) return null;
      return { revision, updated: isoOrNull(entry.updated), status: text(entry.status) || 'unknown', chart: text(entry.chart), appVersion: text(entry.app_version), description: text(entry.description) };
    })
    .filter((entry): entry is HelmHistoryEntry => entry !== null)
    .sort((a, b) => b.revision - a.revision);
};

export const helmStatus = (status: string): StatusInfo => {
  switch (status) {
    case 'deployed':
      return { label: 'Deployed', tone: 'success' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'superseded':
      return { label: 'Superseded', tone: 'muted' };
    case 'uninstalled':
      return { label: 'Uninstalled', tone: 'muted' };
    case 'uninstalling':
      return { label: 'Uninstalling', tone: 'warning' };
    case 'pending-install':
    case 'pending-upgrade':
    case 'pending-rollback':
      return { label: status.replace('pending-', 'Pending '), tone: 'info' };
    default:
      return { label: status ? status[0]!.toUpperCase() + status.slice(1) : 'Unknown', tone: 'muted' };
  }
};

// ----- Names that go to the helm program

const DNS_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Helm's own limit is 53 characters. Nothing starting with a dash can pass, so a name is never read as a flag. */
export const validReleaseName = (name: string): boolean => name.length > 0 && name.length <= 53 && DNS_NAME.test(name);
export const validNamespaceName = (name: string): boolean => name.length > 0 && name.length <= 63 && DNS_LABEL.test(name);
export const validChartVersion = (version: string): boolean => version.length > 0 && version.length <= 64 && /^[0-9A-Za-z][0-9A-Za-z.+_~-]*$/.test(version);
export const validRevision = (revision: number): boolean => Number.isInteger(revision) && revision >= 1 && revision <= 1_000_000;

/**
 * A chart the user may name: `repo/chart` (a repo that is in `helm repo list`) or an `oci://` address.
 * A path, a URL or anything starting with a dash is refused.
 */
export const validChartRef = (ref: string): boolean =>
  ref.length <= 300 && (/^oci:\/\/[A-Za-z0-9][A-Za-z0-9._~/:@-]*$/.test(ref) || /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref));

/** A file path inside a chart rebuilt from a release record: relative, no `..`, no empty parts, no NUL. */
export const safeChartPath = (path: string): boolean =>
  path.length > 0 && path.length < 300 && !path.startsWith('/') && !path.includes('\0') && !path.includes('\\') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

export interface RepoSearch {
  repo: string;
  /** The rows of `helm search repo <repo>/<chart> --versions -o json`. */
  results: Array<{ name?: unknown; version?: unknown }>;
}

export interface ChartCandidate {
  /** `repo/chart` */
  ref: string;
  version: string;
}

/** The repos that hold this chart at exactly the release's version, in repo order. Only an exact version counts: a release is never moved to another version here. */
export const repoCandidates = (chartName: string, chartVersion: string, searches: RepoSearch[]): ChartCandidate[] => {
  if (!chartName || !chartVersion) return [];
  const out: ChartCandidate[] = [];
  for (const search of [...searches].sort((a, b) => a.repo.localeCompare(b.repo))) {
    const ref = `${search.repo}/${chartName}`;
    if (search.results.some((row) => text(row.name) === ref && text(row.version).replace(/^v/, '') === chartVersion.replace(/^v/, ''))) out.push({ ref, version: chartVersion });
  }
  return out;
};

// ----- The table

const col = (id: string, label: string, get: Column['get'], extra: Partial<Column> = {}): Column => ({ id, label, get, ...extra });
const release = (object: Obj): HelmRelease | undefined => object.helm as HelmRelease | undefined;

/** A release as an object the resource table and drawer already know how to carry. */
export const releaseObject = (value: HelmRelease): Obj => ({
  apiVersion: 'helm.sh/v3',
  kind: 'Release',
  metadata: { name: value.name, namespace: value.namespace, uid: `helm:${value.namespace}/${value.name}`, ...(value.updated ? { creationTimestamp: value.updated } : {}) },
  helm: value,
});

const releaseStatus = (object: Obj): StatusInfo => helmStatus(release(object)?.status ?? '');

export const HELM_VIEW: KindView = {
  title: 'Releases',
  columns: [
    col('name', 'Name', (o) => text(o.metadata?.name), { width: 'minmax(150px, 2fr)' }),
    col('namespace', 'Namespace', (o) => text(o.metadata?.namespace), { width: 'minmax(100px, 1fr)' }),
    col('chart', 'Chart', (o) => release(o)?.chartName ?? '', { width: 'minmax(130px, 1.6fr)' }),
    col('revision', 'Revision', (o) => release(o)?.revision ?? null, { width: '80px', align: 'end' }),
    col('version', 'Version', (o) => release(o)?.chartVersion ?? '', { width: 'minmax(80px, 1fr)' }),
    col('appVersion', 'App version', (o) => release(o)?.appVersion ?? '', { width: 'minmax(90px, 1fr)' }),
    col('status', 'Status', (o) => releaseStatus(o).label, { cell: 'status', width: 'minmax(100px, 1fr)' }),
    col('updated', 'Updated', (o) => (release(o)?.updated ? Date.parse(release(o)!.updated!) : null), { cell: 'age', width: '72px', align: 'end', hint: 'Time since the last revision' }),
  ],
  sort: { column: 'name', dir: 'asc' },
  railColumn: 'chart',
  status: releaseStatus,
  details: (o) =>
    [
      ['Chart', release(o)?.chart ?? ''],
      ['Revision', String(release(o)?.revision ?? '')],
      ['App version', release(o)?.appVersion ?? ''],
    ].filter((row): row is [string, string] => row[1] !== ''),
};
