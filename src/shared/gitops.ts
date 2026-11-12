// Flux and Argo CD views: Ready, Synced and Health, revision, last reconcile and message. Pure.
import { timeOf, viewHelpers, type Column, type KindView, type StatusInfo, type Tone } from './kinds.ts';
import type { Obj } from './types.ts';

const { col, NAME, NAMESPACE, AGE, st, kv, condition, text, arr } = viewHelpers;

export type GitopsFamily = 'flux' | 'argo';

/** The kinds the GitOps sections show, by API group. Everything else a CRD adds stays under Custom resources. */
export const GITOPS_KINDS: ReadonlyArray<{ family: GitopsFamily; group: string; kind: string }> = [
  { family: 'flux', group: 'kustomize.toolkit.fluxcd.io', kind: 'Kustomization' },
  { family: 'flux', group: 'helm.toolkit.fluxcd.io', kind: 'HelmRelease' },
  { family: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'GitRepository' },
  { family: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'HelmRepository' },
  { family: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'OCIRepository' },
  { family: 'argo', group: 'argoproj.io', kind: 'Application' },
  { family: 'argo', group: 'argoproj.io', kind: 'ApplicationSet' },
  { family: 'argo', group: 'argoproj.io', kind: 'AppProject' },
];

export const gitopsFamily = (group: string, kind: string): GitopsFamily | null => GITOPS_KINDS.find((entry) => entry.group === group && entry.kind === kind)?.family ?? null;

/** `main@sha1:2f1d6ab4c9e0...` and a bare 40 character hash, shortened to 7 characters of the hash. */
export const shortRevision = (revision: string): string =>
  revision.replace(/\b(sha1|sha256|sha512):([0-9a-f]{8,})/g, (_all, algo: string, hash: string) => `${algo}:${hash.slice(0, 7)}`).replace(/^[0-9a-f]{40,64}$/, (hash) => hash.slice(0, 7));

const tone = (get: (object: Obj) => Tone | null): Partial<Column> => ({ cell: 'tone', tone: get });
const clipMessage = (message: string): string => message.replace(/\s+/g, ' ').trim();

// ----- Flux

const fluxStatus = (object: Obj): StatusInfo => {
  if (object.spec?.suspend === true) return st('Suspended', 'muted');
  if (condition(object, 'Stalled')?.status === 'True') return st('Stalled', 'error');
  const ready = condition(object, 'Ready');
  if (!ready) return st('Pending', 'muted');
  if (ready.status === 'True') return st('Ready', 'success');
  if (ready.status === 'False') return st('Not ready', 'error');
  return condition(object, 'Reconciling')?.status === 'True' ? st('Reconciling', 'info') : st('Unknown', 'warning');
};

const fluxRevision = (object: Obj): string =>
  shortRevision(text(object.status?.lastAppliedRevision ?? object.status?.artifact?.revision ?? object.status?.history?.[0]?.chartVersion ?? object.status?.lastAttemptedRevision));

const refText = (ref: Obj | undefined): string => (ref?.name ? `${text(ref.kind)}/${text(ref.name)}`.replace(/^\//, '') : '');

const fluxSource = (object: Obj): string => {
  if (object.kind === 'Kustomization') return refText(object.spec?.sourceRef);
  if (object.kind === 'HelmRelease') {
    const chart = object.spec?.chart?.spec;
    if (chart) return [text(chart.chart), refText(chart.sourceRef)].filter(Boolean).join(' from ');
    return refText(object.spec?.chartRef);
  }
  return text(object.spec?.url);
};

/** Flux keeps no timestamp for each reconcile; this is the last handled request, else when the artifact or status last changed. */
const fluxReconciled = (object: Obj): number | null =>
  timeOf(object.status?.lastHandledReconcileAt) ?? timeOf(object.status?.artifact?.lastUpdateTime) ?? timeOf(condition(object, 'Ready')?.lastTransitionTime);

const fluxMessage = (object: Obj): string => {
  if (object.spec?.suspend === true) return 'Suspended: no reconciles until it is resumed.';
  return clipMessage(text(condition(object, 'Stalled')?.status === 'True' ? condition(object, 'Stalled')?.message : (condition(object, 'Ready')?.message ?? condition(object, 'Reconciling')?.message)));
};

const fluxView = (title: string, kind: string): KindView => {
  const sourceLabel = kind === 'Kustomization' ? 'Source' : kind === 'HelmRelease' ? 'Chart' : 'URL';
  return {
    title,
    columns: [
      NAME,
      NAMESPACE,
      col('ready', 'Ready', (o) => fluxStatus(o).label, { cell: 'status', width: 'minmax(112px, 1fr)' }),
      col('revision', 'Revision', fluxRevision, { cell: 'mono', width: 'minmax(120px, 1.4fr)' }),
      col('source', sourceLabel, fluxSource, { width: 'minmax(150px, 2fr)' }),
      col('reconciled', 'Last reconcile', fluxReconciled, { cell: 'age', width: '96px', align: 'end', hint: 'When Flux last handled a reconcile, else when the status last changed' }),
      col('message', 'Message', fluxMessage, { width: 'minmax(220px, 4fr)' }),
      AGE,
    ],
    sort: { column: 'name', dir: 'asc' },
    railColumn: 'revision',
    status: fluxStatus,
    details: (o) => kv(['Source', fluxSource(o)], ['Revision', fluxRevision(o)], ['Path', o.spec?.path], ['Interval', o.spec?.interval], ['Suspended', o.spec?.suspend === true ? 'Yes' : ''], ['Message', fluxMessage(o)]),
  };
};

// ----- Argo CD

const syncTone = (status: string): Tone | null => (status === 'Synced' ? 'success' : status === 'OutOfSync' ? 'warning' : status ? 'muted' : null);
const healthTone = (status: string): Tone | null => {
  if (status === 'Healthy') return 'success';
  if (status === 'Progressing') return 'info';
  if (status === 'Degraded' || status === 'Missing') return 'error';
  if (status === 'Suspended') return 'warning';
  return status ? 'muted' : null;
};

const syncOf = (o: Obj): string => text(o.status?.sync?.status);
const healthOf = (o: Obj): string => text(o.status?.health?.status);

const argoStatus = (o: Obj): StatusInfo | null => {
  const sync = syncOf(o);
  const health = healthOf(o);
  if (!sync && !health) return null;
  if (health === 'Degraded' || health === 'Missing') return st(health, 'error');
  if (sync === 'OutOfSync') return st('OutOfSync', 'warning');
  if (health === 'Progressing') return st('Progressing', 'info');
  if (health === 'Suspended') return st('Suspended', 'muted');
  if (sync === 'Synced' && health === 'Healthy') return st('Healthy', 'success');
  return st(health || sync, 'muted');
};

const argoRevision = (o: Obj): string => shortRevision(text(o.status?.sync?.revision ?? o.status?.sync?.revisions?.[0]));
const argoTarget = (o: Obj): string => text(o.spec?.source?.targetRevision ?? arr(o.spec?.sources)[0]?.targetRevision);
const argoRepo = (o: Obj): string => text(o.spec?.source?.repoURL ?? arr(o.spec?.sources)[0]?.repoURL ?? o.spec?.source?.chart);

const argoDestination = (o: Obj): string => {
  const where = text(o.spec?.destination?.name) || text(o.spec?.destination?.server).replace(/^https?:\/\//, '');
  const namespace = text(o.spec?.destination?.namespace);
  return [namespace, where].filter(Boolean).join(' on ');
};

const argoMessage = (o: Obj): string => clipMessage(text(o.status?.operationState?.message || arr(o.status?.conditions)[0]?.message));

const argoApplicationView: KindView = {
  title: 'Applications',
  columns: [
    NAME,
    NAMESPACE,
    col('sync', 'Sync', syncOf, { ...tone((o) => syncTone(syncOf(o))), width: 'minmax(90px, 1fr)' }),
    col('health', 'Health', healthOf, { ...tone((o) => healthTone(healthOf(o))), width: 'minmax(90px, 1fr)' }),
    col('revision', 'Revision', argoRevision, { cell: 'mono', width: 'minmax(90px, 1fr)', hint: 'The revision last synced' }),
    col('target', 'Target', argoTarget, { width: 'minmax(80px, 1fr)', hint: 'The branch, tag or version the application follows' }),
    col('project', 'Project', (o) => text(o.spec?.project), { width: 'minmax(90px, 1fr)' }),
    col('destination', 'Destination', argoDestination, { width: 'minmax(140px, 2fr)' }),
    col('reconciled', 'Last reconcile', (o) => timeOf(o.status?.reconciledAt), { cell: 'age', width: '96px', align: 'end' }),
    col('message', 'Message', argoMessage, { width: 'minmax(200px, 3fr)' }),
  ],
  sort: { column: 'name', dir: 'asc' },
  railColumn: 'health',
  status: argoStatus,
  details: (o) => kv(['Sync', syncOf(o)], ['Health', healthOf(o)], ['Revision', argoRevision(o)], ['Target', argoTarget(o)], ['Repository', argoRepo(o)], ['Project', o.spec?.project], ['Destination', argoDestination(o)], ['Message', argoMessage(o)]),
};

const applicationSetStatus = (o: Obj): StatusInfo | null => {
  if (condition(o, 'ErrorOccurred')?.status === 'True') return st('Error', 'error');
  if (condition(o, 'ResourcesUpToDate')?.status === 'True') return st('Up to date', 'success');
  if (condition(o, 'ParametersGenerated')?.status === 'False') return st('Not generated', 'warning');
  return arr(o.status?.conditions).length > 0 ? st('Pending', 'info') : null;
};

const generators = (o: Obj): string => arr(o.spec?.generators).map((entry) => Object.keys(entry)[0] ?? '').filter(Boolean).join(', ');
const appSetMessage = (o: Obj): string => clipMessage(text(condition(o, 'ErrorOccurred')?.status === 'True' ? condition(o, 'ErrorOccurred')?.message : (condition(o, 'ResourcesUpToDate')?.message ?? condition(o, 'ParametersGenerated')?.message)));

const argoApplicationSetView: KindView = {
  title: 'ApplicationSets',
  columns: [
    NAME,
    NAMESPACE,
    col('ready', 'Ready', (o) => applicationSetStatus(o)?.label ?? '', { cell: 'status', width: 'minmax(100px, 1fr)' }),
    col('generators', 'Generators', generators, { width: 'minmax(120px, 1.4fr)' }),
    col('applications', 'Applications', (o) => (Array.isArray(o.status?.applicationStatus) ? o.status.applicationStatus.length : null), { width: '100px', align: 'end' }),
    col('message', 'Message', appSetMessage, { width: 'minmax(220px, 4fr)' }),
    AGE,
  ],
  sort: { column: 'name', dir: 'asc' },
  railColumn: 'ready',
  status: applicationSetStatus,
  details: (o) => kv(['Generators', generators(o)], ['Applications', Array.isArray(o.status?.applicationStatus) ? String(o.status.applicationStatus.length) : ''], ['Message', appSetMessage(o)]),
};

const argoProjectView: KindView = {
  title: 'AppProjects',
  columns: [
    NAME,
    NAMESPACE,
    col('description', 'Description', (o) => text(o.spec?.description), { width: 'minmax(200px, 4fr)' }),
    col('sources', 'Sources', (o) => arr(o.spec?.sourceRepos).length, { width: '80px', align: 'end' }),
    col('destinations', 'Destinations', (o) => arr(o.spec?.destinations).length, { width: '100px', align: 'end' }),
    AGE,
  ],
  sort: { column: 'name', dir: 'asc' },
  railColumn: 'description',
  details: (o) => kv(['Description', o.spec?.description], ['Source repositories', arr(o.spec?.sourceRepos).length], ['Destinations', arr(o.spec?.destinations).length]),
};

/** The curated view for a GitOps kind, or null for any other kind. */
export const gitopsView = (group: string, kind: string): KindView | null => {
  const family = gitopsFamily(group, kind);
  if (family === 'flux') return fluxView(kind.endsWith('y') ? `${kind.slice(0, -1)}ies` : `${kind}s`, kind);
  if (family === 'argo') return kind === 'Application' ? argoApplicationView : kind === 'ApplicationSet' ? argoApplicationSetView : argoProjectView;
  return null;
};
