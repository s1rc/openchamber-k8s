// Kind registry. The first half holds API paths (used by the service); the second half holds what the panel shows
// for each kind: columns, status, sorting and overview details. Actions arrive in Phase 3.
import { ageText, bytesText, coresText, cpuText, parseQuantity } from './format.ts';
import { HELM_RELEASES } from './helm.ts';
import { podUsageKey, type UsageSet } from './metrics.ts';
import type { Obj } from './types.ts';

export interface KindInfo {
  kind: string;
  plural: string;
  /** Empty string for the core group. */
  group: string;
  version: string;
  namespaced: boolean;
  aliases?: string[];
}

const k = (kind: string, plural: string, group: string, version: string, namespaced: boolean, aliases: string[] = []): KindInfo => ({
  kind,
  plural,
  group,
  version,
  namespaced,
  aliases,
});

export const KINDS: KindInfo[] = [
  k('Pod', 'pods', '', 'v1', true, ['po']),
  k('Node', 'nodes', '', 'v1', false, ['no']),
  k('Namespace', 'namespaces', '', 'v1', false, ['ns']),
  k('Service', 'services', '', 'v1', true, ['svc']),
  k('Endpoints', 'endpoints', '', 'v1', true, ['ep']),
  k('ConfigMap', 'configmaps', '', 'v1', true, ['cm']),
  k('Secret', 'secrets', '', 'v1', true),
  k('ResourceQuota', 'resourcequotas', '', 'v1', true, ['quota']),
  k('LimitRange', 'limitranges', '', 'v1', true, ['limits']),
  k('PersistentVolumeClaim', 'persistentvolumeclaims', '', 'v1', true, ['pvc']),
  k('PersistentVolume', 'persistentvolumes', '', 'v1', false, ['pv']),
  k('ServiceAccount', 'serviceaccounts', '', 'v1', true, ['sa']),
  k('Event', 'events', '', 'v1', true, ['ev']),
  k('Deployment', 'deployments', 'apps', 'v1', true, ['deploy']),
  k('DaemonSet', 'daemonsets', 'apps', 'v1', true, ['ds']),
  k('StatefulSet', 'statefulsets', 'apps', 'v1', true, ['sts']),
  k('ReplicaSet', 'replicasets', 'apps', 'v1', true, ['rs']),
  k('Job', 'jobs', 'batch', 'v1', true),
  k('CronJob', 'cronjobs', 'batch', 'v1', true, ['cj']),
  k('HorizontalPodAutoscaler', 'horizontalpodautoscalers', 'autoscaling', 'v2', true, ['hpa']),
  k('PodDisruptionBudget', 'poddisruptionbudgets', 'policy', 'v1', true, ['pdb']),
  k('PriorityClass', 'priorityclasses', 'scheduling.k8s.io', 'v1', false, ['pc']),
  k('RuntimeClass', 'runtimeclasses', 'node.k8s.io', 'v1', false),
  k('Lease', 'leases', 'coordination.k8s.io', 'v1', true),
  k('MutatingWebhookConfiguration', 'mutatingwebhookconfigurations', 'admissionregistration.k8s.io', 'v1', false),
  k('ValidatingWebhookConfiguration', 'validatingwebhookconfigurations', 'admissionregistration.k8s.io', 'v1', false),
  k('EndpointSlice', 'endpointslices', 'discovery.k8s.io', 'v1', true),
  k('Ingress', 'ingresses', 'networking.k8s.io', 'v1', true, ['ing']),
  k('IngressClass', 'ingressclasses', 'networking.k8s.io', 'v1', false),
  k('NetworkPolicy', 'networkpolicies', 'networking.k8s.io', 'v1', true, ['netpol']),
  k('StorageClass', 'storageclasses', 'storage.k8s.io', 'v1', false, ['sc']),
  k('ClusterRole', 'clusterroles', 'rbac.authorization.k8s.io', 'v1', false),
  k('Role', 'roles', 'rbac.authorization.k8s.io', 'v1', true),
  k('ClusterRoleBinding', 'clusterrolebindings', 'rbac.authorization.k8s.io', 'v1', false),
  k('RoleBinding', 'rolebindings', 'rbac.authorization.k8s.io', 'v1', true),
  k('CustomResourceDefinition', 'customresourcedefinitions', 'apiextensions.k8s.io', 'v1', false, ['crd']),
];

const norm = (text: string): string => text.trim().toLowerCase();

/** Finds a kind by kind, plural or short name, case-insensitive. */
export const findKind = (input: string): KindInfo | undefined => {
  const wanted = norm(input);
  return KINDS.find((info) => norm(info.kind) === wanted || info.plural === wanted || info.aliases?.includes(wanted));
};

/** Finds a kind by its apiVersion and kind, e.g. `apps/v1` and `Deployment`. The version in the path follows the apiVersion. */
export const findKindByApiVersion = (apiVersion: string, kind: string): KindInfo | undefined => {
  const slash = apiVersion.indexOf('/');
  const group = slash < 0 ? '' : apiVersion.slice(0, slash);
  const version = slash < 0 ? apiVersion : apiVersion.slice(slash + 1);
  const found = KINDS.find((info) => info.group === group && info.kind === kind);
  return found ? { ...found, version } : undefined;
};

/** REST path of a kind. `namespace` null lists across all namespaces (or addresses a cluster-scoped kind). */
export const kindPath = (info: KindInfo, namespace: string | null, name?: string): string => {
  const base = info.group ? `/apis/${info.group}/${info.version}` : `/api/${info.version}`;
  const scoped = info.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
  const named = name ? `/${encodeURIComponent(name)}` : '';
  return `${base}${scoped}/${info.plural}${named}`;
};

export const SCALABLE = new Set(['Deployment', 'StatefulSet', 'ReplicaSet']);
export const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
export const isSecret = (info: Pick<KindInfo, 'kind' | 'group'>): boolean => info.kind === 'Secret' && info.group === '';

// ---------------------------------------------------------------------------------------------------------------
// What the panel shows for each kind

export type Tone = 'success' | 'warning' | 'error' | 'info' | 'muted';

export interface StatusInfo {
  label: string;
  tone: Tone;
}

/** How the table draws a cell. `age` cells hold a time in ms and show `3d4h`; `status` cells use the view's status function. */
export type CellKind = 'text' | 'mono' | 'age' | 'status' | 'containers' | 'meter' | 'tone';

/** What a column may need besides the object: the live numbers from metrics-server. */
export interface ViewContext {
  usage?: UsageSet | null;
}

/** A usage cell: the text, and how full it is (0 to 1) when the cluster gave numbers. */
export interface Meter {
  text: string;
  fraction: number | null;
}

export interface Column {
  id: string;
  label: string;
  /** The text shown, or a number. Age cells return the time in epoch ms. */
  get: (object: Obj, ctx?: ViewContext) => string | number | null;
  /** What to sort by when the shown text does not sort right (sizes, versions). */
  sort?: (object: Obj, ctx?: ViewContext) => string | number | null;
  /** For `meter` cells: the bar under the text. Null draws the text alone. */
  meter?: (object: Obj, ctx?: ViewContext) => Meter | null;
  /** For `tone` cells: the dot before the text. Null draws the text alone. */
  tone?: (object: Obj) => Tone | null;
  cell?: CellKind;
  /** A CSS grid track, e.g. `minmax(120px, 1fr)`. */
  width?: string;
  hint?: string;
  align?: 'end';
}

export interface KindView {
  title: string;
  columns: Column[];
  status?: (object: Obj) => StatusInfo | null;
  sort: { column: string; dir: 'asc' | 'desc' };
  /** The one column shown next to the name in the narrow list. Defaults to Age. */
  railColumn?: string;
  /** The title in the narrow list, when the name says nothing (events). */
  railTitle?: (object: Obj) => string;
  /** Rows for the Overview tab, after the common fields. */
  details?: (object: Obj) => Array<[string, string]>;
}

const arr = (value: unknown): Obj[] => (Array.isArray(value) ? (value as Obj[]) : []);
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const keysOf = (value: unknown): string[] => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as Obj) : []);
export const timeOf = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const pairs = (value: unknown): string => keysOf(value).map((key) => `${key}=${text((value as Obj)[key])}`).join(', ');
const more = (items: string[], shown = 3): string => (items.length > shown ? `${items.slice(0, shown).join(', ')} (+${items.length - shown})` : items.join(', '));
const trueConditions = (object: Obj): string[] => arr(object.status?.conditions).filter((c) => c.status === 'True').map((c) => text(c.type));
const condition = (object: Obj, type: string): Obj | undefined => arr(object.status?.conditions).find((c) => c.type === type);
const owner = (object: Obj): Obj | undefined => arr(object.metadata?.ownerReferences).find((r) => r.controller) ?? arr(object.metadata?.ownerReferences)[0];
const ratio = (ready: unknown, desired: unknown): string => `${count(ready)}/${count(desired)}`;
const st = (label: string, tone: Tone): StatusInfo => ({ label, tone });
const kv = (...rows: Array<[string, unknown]>): Array<[string, string]> => rows.map(([key, value]): [string, string] => [key, text(value)]).filter(([, value]) => value !== '');

// ----- Pod

/** The status kubectl prints for a pod: the phase, or the most telling container or init container reason. */
export const podReason = (pod: Obj): string => {
  const status = pod.status ?? {};
  let reason = text(status.reason) || text(status.phase) || 'Unknown';
  const inits = arr(status.initContainerStatuses);
  let initializing = false;
  for (let i = 0; i < inits.length; i += 1) {
    const state = inits[i]!.state ?? {};
    if (state.terminated && state.terminated.exitCode === 0) continue;
    initializing = true;
    if (state.terminated) reason = state.terminated.reason ? `Init:${state.terminated.reason}` : state.terminated.signal ? `Init:Signal:${state.terminated.signal}` : `Init:ExitCode:${state.terminated.exitCode}`;
    else if (state.waiting?.reason && state.waiting.reason !== 'PodInitializing') reason = `Init:${state.waiting.reason}`;
    else reason = `Init:${i}/${inits.length}`;
    break;
  }
  if (!initializing) {
    let running = false;
    const containers = arr(status.containerStatuses);
    for (let i = containers.length - 1; i >= 0; i -= 1) {
      const c = containers[i]!;
      const state = c.state ?? {};
      if (state.waiting?.reason) reason = state.waiting.reason;
      else if (state.terminated?.reason) reason = state.terminated.reason;
      else if (state.terminated) reason = state.terminated.signal ? `Signal:${state.terminated.signal}` : `ExitCode:${state.terminated.exitCode}`;
      else if (c.ready && state.running) running = true;
    }
    if (reason === 'Completed' && running) reason = condition(pod, 'Ready')?.status === 'True' ? 'Running' : 'NotReady';
  }
  if (pod.metadata?.deletionTimestamp) reason = status.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
  return reason;
};

export const podStatus = (pod: Obj): StatusInfo => {
  const reason = podReason(pod);
  if (reason === 'Running') return condition(pod, 'Ready')?.status === 'True' ? st(reason, 'success') : st(reason, 'warning');
  if (reason === 'Completed' || reason === 'Succeeded') return st(reason === 'Succeeded' ? 'Completed' : reason, 'muted');
  if (reason === 'Pending' || reason === 'ContainerCreating' || reason === 'PodInitializing' || /^Init:\d+\/\d+$/.test(reason)) return st(reason, 'info');
  if (reason === 'Terminating' || reason === 'Unknown' || reason === 'NotReady') return st(reason, 'warning');
  return st(reason, 'error');
};

/** One entry per container: its state as a tone, for the dots in the table. */
export const containerStates = (pod: Obj): Array<{ name: string; tone: Tone; state: string }> => {
  const byName = new Map(arr(pod.status?.containerStatuses).map((c) => [text(c.name), c]));
  return arr(pod.spec?.containers).map((container) => {
    const name = text(container.name);
    const status = byName.get(name);
    const state = status?.state ?? {};
    if (state.running) return status?.ready ? { name, tone: 'success' as Tone, state: 'Running' } : { name, tone: 'warning' as Tone, state: 'Running, not ready' };
    if (state.waiting) return { name, tone: /BackOff|Err|Invalid|Error/.test(text(state.waiting.reason)) ? ('error' as Tone) : ('info' as Tone), state: text(state.waiting.reason) || 'Waiting' };
    if (state.terminated) return { name, tone: state.terminated.exitCode === 0 ? ('muted' as Tone) : ('error' as Tone), state: text(state.terminated.reason) || 'Terminated' };
    return { name, tone: 'muted' as Tone, state: 'Unknown' };
  });
};

const restarts = (pod: Obj): number => arr(pod.status?.containerStatuses).reduce((sum, c) => sum + count(c.restartCount), 0);

/** The pod spec a workload runs, for the containers block. */
export const podSpecOf = (object: Obj): Obj | null => {
  if (object.kind === 'Pod') return object.spec ?? null;
  if (object.kind === 'CronJob') return object.spec?.jobTemplate?.spec?.template?.spec ?? null;
  return object.spec?.template?.spec ?? null;
};

// ----- Workloads

const readyRatio = (kind: string, object: Obj): { ready: number; desired: number } => {
  switch (kind) {
    case 'DaemonSet':
      return { ready: count(object.status?.numberReady), desired: count(object.status?.desiredNumberScheduled) };
    case 'StatefulSet':
    case 'ReplicaSet':
      return { ready: count(object.status?.readyReplicas), desired: object.spec?.replicas === undefined ? 1 : count(object.spec.replicas) };
    default:
      return { ready: count(object.status?.readyReplicas), desired: object.spec?.replicas === undefined ? 1 : count(object.spec.replicas) };
  }
};

const workloadStatus = (kind: string) => (object: Obj): StatusInfo => {
  const { ready, desired } = readyRatio(kind, object);
  if (kind === 'Deployment') {
    if (condition(object, 'ReplicaFailure')?.status === 'True') return st('Failing', 'error');
    if (condition(object, 'Available')?.status === 'False') return st('Unavailable', 'error');
    if (condition(object, 'Progressing')?.status === 'False') return st('Stalled', 'error');
  }
  if (desired === 0) return st('Scaled to 0', 'muted');
  if (ready < desired) return st(ready === 0 ? 'Not ready' : 'Updating', ready === 0 ? 'error' : 'info');
  return st(kind === 'DaemonSet' ? 'Ready' : 'Available', 'success');
};

const jobStatus = (job: Obj): StatusInfo => {
  if (trueConditions(job).includes('Failed')) return st('Failed', 'error');
  if (trueConditions(job).includes('Complete')) return st('Complete', 'success');
  if (job.spec?.suspend) return st('Suspended', 'muted');
  if (count(job.status?.active) > 0) return st('Running', 'info');
  return st('Pending', 'muted');
};

// ----- Node

const nodeRoles = (node: Obj): string => {
  const prefix = 'node-role.kubernetes.io/';
  const roles = keysOf(node.metadata?.labels).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length) || 'worker');
  const legacy = node.metadata?.labels?.['kubernetes.io/role'];
  if (legacy && !roles.includes(legacy)) roles.push(text(legacy));
  return roles.join(', ');
};

const nodeStatus = (node: Obj): StatusInfo => {
  const ready = condition(node, 'Ready');
  if (!ready || ready.status !== 'True') return st('NotReady', 'error');
  if (node.spec?.unschedulable) return st('Ready, SchedulingDisabled', 'warning');
  const pressure = ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].filter((type) => condition(node, type)?.status === 'True');
  return pressure.length > 0 ? st(pressure.join(', '), 'warning') : st('Ready', 'success');
};

const nodeAddress = (node: Obj, type: string): string => text(arr(node.status?.addresses).find((a) => a.type === type)?.address);

const nodeUse = (node: Obj, ctx?: ViewContext) => ctx?.usage?.nodes.get(text(node.metadata?.name));
const podUse = (pod: Obj, ctx?: ViewContext) => ctx?.usage?.pods.get(podUsageKey(text(pod.metadata?.namespace), text(pod.metadata?.name)));

/**
 * The text of a node's CPU, memory or disk cell. With usage it is `used / size`; a node that metrics-server has not
 * measured yet shows `- / size`, so a bare size is never mistaken for usage. Without usage it is the allocatable size.
 */
const nodeCell = (node: Obj, ctx: ViewContext | undefined, what: 'cpu' | 'memory' | 'disk'): string => {
  const meter = nodeMeter(node, ctx, what);
  if (meter) return meter.text;
  const size = what === 'cpu' ? coresText(quantityValue(node.status?.allocatable?.cpu)) : bytesText(quantityValue(node.status?.allocatable?.[what === 'memory' ? 'memory' : 'ephemeral-storage']));
  const measuring = ctx?.usage?.status === 'ok' && (what !== 'disk' || ctx.usage.diskStatus === 'ok');
  return measuring && size ? `- / ${size}` : size;
};

/** `used / size` and how full it is, for a node's CPU, memory or disk. Null when metrics-server gave no number. */
export const nodeMeter = (node: Obj, ctx: ViewContext | undefined, what: 'cpu' | 'memory' | 'disk'): Meter | null => {
  const use = nodeUse(node, ctx);
  if (!use) return null;
  if (what === 'disk') {
    if (use.diskUsed === null || use.diskCapacity === null || !(use.diskCapacity > 0)) return null;
    return { text: `${bytesText(use.diskUsed)} / ${bytesText(use.diskCapacity)}`, fraction: use.diskUsed / use.diskCapacity };
  }
  const used = what === 'cpu' ? use.cpu : use.memory;
  const size = quantityValue(node.status?.allocatable?.[what]);
  if (used === null || size === null || !(size > 0)) return null;
  return what === 'cpu' ? { text: `${coresText(used)} / ${coresText(size)}`, fraction: used / size } : { text: `${bytesText(used)} / ${bytesText(size)}`, fraction: used / size };
};

// ----- Network and storage

const servicePorts = (service: Obj): string =>
  arr(service.spec?.ports).map((p) => `${text(p.port)}${p.nodePort ? `:${text(p.nodePort)}` : ''}/${text(p.protocol) || 'TCP'}`).join(', ');

const loadBalancers = (object: Obj): string[] => arr(object.status?.loadBalancer?.ingress).map((i) => text(i.hostname || i.ip)).filter(Boolean);

const externalIp = (service: Obj): string => {
  const list = [...loadBalancers(service), ...(Array.isArray(service.spec?.externalIPs) ? (service.spec.externalIPs as string[]) : [])];
  if (list.length === 0 && service.spec?.type === 'ExternalName') return text(service.spec.externalName);
  return more(list, 2);
};

const endpointsText = (endpoints: Obj): string => {
  const list: string[] = [];
  for (const subset of arr(endpoints.subsets)) {
    const ports = arr(subset.ports).map((p) => text(p.port));
    for (const address of arr(subset.addresses)) list.push(ports.length > 0 ? `${text(address.ip)}:${ports[0]}` : text(address.ip));
  }
  return more(list);
};

const quantityValue = (value: unknown): number | null => parseQuantity(value);

const pvcSize = (pvc: Obj): string => text(pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage);

const isDefaultClass = (storageClass: Obj): boolean =>
  storageClass.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' || storageClass.metadata?.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true';

const hpaMetrics = (hpa: Obj): string => {
  const parts = arr(hpa.spec?.metrics).map((metric) => {
    if (metric.type !== 'Resource' || !metric.resource) return text(metric.type);
    const name = text(metric.resource.name);
    const target = metric.resource.target?.averageUtilization !== undefined ? `${text(metric.resource.target.averageUtilization)}%` : text(metric.resource.target?.averageValue ?? metric.resource.target?.value);
    const current = arr(hpa.status?.currentMetrics).find((c) => c.type === 'Resource' && c.resource?.name === name)?.resource?.current;
    const now = current?.averageUtilization !== undefined ? `${text(current.averageUtilization)}%` : text(current?.averageValue ?? current?.value) || '<unknown>';
    return `${name} ${now}/${target}`;
  });
  return more(parts, 2);
};

const subjects = (binding: Obj): string => more(arr(binding.subjects).map((s) => `${text(s.kind)}:${text(s.name)}`), 2);

// ----- Events

export const eventTime = (event: Obj): number | null =>
  timeOf(event.lastTimestamp) ?? timeOf(event.series?.lastObservedTime) ?? timeOf(event.eventTime) ?? timeOf(event.firstTimestamp) ?? timeOf(event.metadata?.creationTimestamp);

const involved = (event: Obj): string => {
  const ref = event.involvedObject ?? event.regarding;
  return ref ? `${text(ref.kind)}/${text(ref.name)}` : '';
};

// ----- Columns

const col = (id: string, label: string, get: Column['get'], extra: Partial<Column> = {}): Column => ({ id, label, get, ...extra });
const NAME = col('name', 'Name', (o) => text(o.metadata?.name), { width: 'minmax(150px, 2.4fr)' });
const NAMESPACE = col('namespace', 'Namespace', (o) => text(o.metadata?.namespace), { width: 'minmax(90px, 1fr)' });
const AGE = col('age', 'Age', (o) => timeOf(o.metadata?.creationTimestamp), { cell: 'age', width: '56px', align: 'end' });
const status = (fn: (object: Obj) => StatusInfo, label = 'Status'): Column => col('status', label, (o) => fn(o).label, { cell: 'status', width: 'minmax(90px, 1.1fr)' });
const num = (id: string, label: string, get: Column['get'], extra: Partial<Column> = {}): Column => col(id, label, get, { width: '64px', align: 'end', ...extra });

const view = (title: string, columns: Column[], extra: Partial<KindView> = {}): KindView => ({ title, columns, sort: { column: 'name', dir: 'asc' }, ...extra });

const VIEWS: Record<string, KindView> = {
  Pod: view(
    'Pods',
    [
      NAME,
      NAMESPACE,
      col('containers', 'Containers', (o) => arr(o.spec?.containers).length, { cell: 'containers', width: '88px' }),
      num('cpu', 'CPU', (o, ctx) => cpuText(podUse(o, ctx)?.cpu), { sort: (o, ctx) => podUse(o, ctx)?.cpu ?? null, hint: 'Current usage from metrics-server' }),
      num('memory', 'Memory', (o, ctx) => bytesText(podUse(o, ctx)?.memory), { sort: (o, ctx) => podUse(o, ctx)?.memory ?? null, width: '84px', hint: 'Current usage from metrics-server' }),
      num('restarts', 'Restarts', (o) => restarts(o)),
      col('controlledBy', 'Controlled by', (o) => text(owner(o)?.kind), { width: 'minmax(80px, 1fr)' }),
      col('node', 'Node', (o) => text(o.spec?.nodeName), { width: 'minmax(110px, 1.5fr)' }),
      col('qos', 'QoS', (o) => text(o.status?.qosClass), { width: '80px' }),
      AGE,
      status(podStatus),
    ],
    {
      status: podStatus,
      railColumn: 'restarts',
      details: (o) => kv(['Node', o.spec?.nodeName], ['Pod IP', o.status?.podIP], ['Host IP', o.status?.hostIP], ['QoS', o.status?.qosClass], ['Service account', o.spec?.serviceAccountName], ['Restart policy', o.spec?.restartPolicy], ['Priority class', o.spec?.priorityClassName]),
    },
  ),
  Node: view(
    'Nodes',
    [
      NAME,
      num('cpu', 'CPU', (o, ctx) => nodeCell(o, ctx, 'cpu'), {
        cell: 'meter',
        meter: (o, ctx) => nodeMeter(o, ctx, 'cpu'),
        sort: (o, ctx) => (nodeUse(o, ctx)?.cpu ?? quantityValue(o.status?.allocatable?.cpu)),
        width: '120px',
        hint: 'Cores in use of allocatable (from metrics-server). Allocatable only when there is no usage.',
      }),
      num('memory', 'Memory', (o, ctx) => nodeCell(o, ctx, 'memory'), {
        cell: 'meter',
        meter: (o, ctx) => nodeMeter(o, ctx, 'memory'),
        sort: (o, ctx) => (nodeUse(o, ctx)?.memory ?? quantityValue(o.status?.allocatable?.memory)),
        width: '150px',
        hint: 'Memory in use of allocatable (from metrics-server). Allocatable only when there is no usage.',
      }),
      num('disk', 'Disk', (o, ctx) => nodeCell(o, ctx, 'disk'), {
        cell: 'meter',
        meter: (o, ctx) => nodeMeter(o, ctx, 'disk'),
        sort: (o, ctx) => (nodeUse(o, ctx)?.diskUsed ?? quantityValue(o.status?.allocatable?.['ephemeral-storage'])),
        width: '150px',
        hint: 'Root disk used of its size (read from the kubelet). Allocatable only when that is not readable.',
      }),
      num('taints', 'Taints', (o) => arr(o.spec?.taints).length),
      col('roles', 'Roles', (o) => nodeRoles(o), { width: 'minmax(80px, 1fr)' }),
      col('version', 'Version', (o) => text(o.status?.nodeInfo?.kubeletVersion), { width: 'minmax(130px, 1fr)' }),
      AGE,
      status(nodeStatus, 'Conditions'),
    ],
    {
      status: nodeStatus,
      railColumn: 'cpu',
      details: (o) => {
        const info = o.status?.nodeInfo ?? {};
        return kv(
          ['Roles', nodeRoles(o)],
          ['Kubelet', info.kubeletVersion],
          ['OS image', info.osImage],
          ['Kernel', info.kernelVersion],
          ['Container runtime', info.containerRuntimeVersion],
          ['Architecture', info.architecture],
          ['Internal IP', nodeAddress(o, 'InternalIP')],
          ['External IP', nodeAddress(o, 'ExternalIP')],
          ['Hostname', nodeAddress(o, 'Hostname')],
          ['Provider ID', o.spec?.providerID],
          ['CPU', `${text(o.status?.allocatable?.cpu)} allocatable of ${text(o.status?.capacity?.cpu)}`],
          ['Memory', `${bytesText(quantityValue(o.status?.allocatable?.memory))} allocatable of ${bytesText(quantityValue(o.status?.capacity?.memory))}`],
          ['Pods', `${text(o.status?.allocatable?.pods)} allocatable`],
          ['Taints', arr(o.spec?.taints).map((t) => `${text(t.key)}${t.value ? `=${text(t.value)}` : ''}:${text(t.effect)}`).join(', ')],
        );
      },
    },
  ),
  Deployment: view(
    'Deployments',
    [
      NAME,
      NAMESPACE,
      num('pods', 'Pods', (o) => ratio(o.status?.readyReplicas, o.spec?.replicas ?? 1), { sort: (o) => count(o.status?.readyReplicas), width: '80px' }),
      num('replicas', 'Replicas', (o) => count(o.spec?.replicas ?? 1)),
      AGE,
      col('conditions', 'Conditions', (o) => trueConditions(o).join(', '), { width: 'minmax(120px, 1.4fr)' }),
      status(workloadStatus('Deployment')),
    ],
    {
      status: workloadStatus('Deployment'),
      railColumn: 'pods',
      details: (o) => kv(['Replicas', `${count(o.status?.readyReplicas)} ready of ${count(o.spec?.replicas ?? 1)} desired, ${count(o.status?.updatedReplicas)} updated, ${count(o.status?.availableReplicas)} available`], ['Strategy', o.spec?.strategy?.type], ['Selector', pairs(o.spec?.selector?.matchLabels)], ['Paused', o.spec?.paused ? 'Yes' : '']),
    },
  ),
  DaemonSet: view(
    'DaemonSets',
    [NAME, NAMESPACE, num('pods', 'Pods', (o) => ratio(o.status?.numberReady, o.status?.desiredNumberScheduled), { width: '80px' }), col('selector', 'Node selector', (o) => pairs(o.spec?.template?.spec?.nodeSelector), { width: 'minmax(120px, 1.4fr)' }), AGE, status(workloadStatus('DaemonSet'))],
    {
      status: workloadStatus('DaemonSet'),
      railColumn: 'pods',
      details: (o) => kv(['Scheduled', `${count(o.status?.currentNumberScheduled)} of ${count(o.status?.desiredNumberScheduled)}`], ['Ready', count(o.status?.numberReady)], ['Selector', pairs(o.spec?.selector?.matchLabels)], ['Update strategy', o.spec?.updateStrategy?.type]),
    },
  ),
  StatefulSet: view(
    'StatefulSets',
    [NAME, NAMESPACE, num('pods', 'Pods', (o) => ratio(o.status?.readyReplicas, o.spec?.replicas ?? 1), { width: '80px' }), AGE, status(workloadStatus('StatefulSet'))],
    {
      status: workloadStatus('StatefulSet'),
      railColumn: 'pods',
      details: (o) => kv(['Replicas', `${count(o.status?.readyReplicas)} ready of ${count(o.spec?.replicas ?? 1)}`], ['Service', o.spec?.serviceName], ['Selector', pairs(o.spec?.selector?.matchLabels)], ['Update strategy', o.spec?.updateStrategy?.type]),
    },
  ),
  ReplicaSet: view(
    'ReplicaSets',
    [NAME, NAMESPACE, num('desired', 'Desired', (o) => count(o.spec?.replicas ?? 1)), num('current', 'Current', (o) => count(o.status?.replicas)), num('ready', 'Ready', (o) => count(o.status?.readyReplicas)), col('controlledBy', 'Controlled by', (o) => (owner(o) ? `${text(owner(o)!.kind)}/${text(owner(o)!.name)}` : ''), { width: 'minmax(140px, 1.5fr)' }), AGE],
    { railColumn: 'ready' },
  ),
  Job: view(
    'Jobs',
    [
      NAME,
      NAMESPACE,
      num('completions', 'Completions', (o) => `${count(o.status?.succeeded)}/${count(o.spec?.completions ?? 1)}`, { width: '100px' }),
      col('conditions', 'Conditions', (o) => trueConditions(o).join(', '), { width: 'minmax(100px, 1fr)' }),
      AGE,
      status(jobStatus),
    ],
    {
      status: jobStatus,
      railColumn: 'completions',
      details: (o) => kv(['Completions', `${count(o.status?.succeeded)} of ${count(o.spec?.completions ?? 1)}`], ['Parallelism', o.spec?.parallelism], ['Backoff limit', o.spec?.backoffLimit], ['Active', o.status?.active], ['Failed', o.status?.failed], ['Started', o.status?.startTime], ['Completed', o.status?.completionTime]),
    },
  ),
  CronJob: view(
    'CronJobs',
    [
      NAME,
      NAMESPACE,
      col('schedule', 'Schedule', (o) => text(o.spec?.schedule), { cell: 'mono', width: 'minmax(110px, 1fr)' }),
      col('suspend', 'Suspend', (o) => (o.spec?.suspend ? 'Yes' : 'No'), { width: '80px' }),
      num('active', 'Active', (o) => arr(o.status?.active).length),
      col('lastSchedule', 'Last schedule', (o) => timeOf(o.status?.lastScheduleTime), { cell: 'age', width: '110px', align: 'end' }),
      AGE,
    ],
    {
      railColumn: 'schedule',
      status: (o) => (o.spec?.suspend ? st('Suspended', 'muted') : st('Scheduled', 'success')),
      details: (o) => kv(['Schedule', o.spec?.schedule], ['Suspended', o.spec?.suspend ? 'Yes' : 'No'], ['Concurrency', o.spec?.concurrencyPolicy], ['Last schedule', o.status?.lastScheduleTime], ['Last success', o.status?.lastSuccessfulTime]),
    },
  ),

  ConfigMap: view('ConfigMaps', [NAME, NAMESPACE, num('keys', 'Keys', (o) => keysOf(o.data).length + keysOf(o.binaryData).length), AGE], { railColumn: 'keys', details: (o) => kv(['Keys', [...keysOf(o.data), ...keysOf(o.binaryData)].join(', ')]) }),
  Secret: view(
    'Secrets',
    [NAME, NAMESPACE, col('labels', 'Labels', (o) => pairs(o.metadata?.labels), { width: 'minmax(120px, 1.5fr)' }), num('keys', 'Keys', (o) => keysOf(o.data).length + keysOf(o.stringData).length), col('type', 'Type', (o) => text(o.type), { width: 'minmax(160px, 1.5fr)' }), AGE],
    { railColumn: 'type', details: (o) => kv(['Type', o.type], ['Keys', [...keysOf(o.data), ...keysOf(o.stringData)].join(', ')]) },
  ),
  ResourceQuota: view('ResourceQuotas', [NAME, NAMESPACE, num('resources', 'Resources', (o) => keysOf(o.spec?.hard).length), AGE], { details: (o) => kv(...keysOf(o.spec?.hard).map((key): [string, unknown] => [key, `${text(o.status?.used?.[key] ?? '0')} used of ${text(o.spec.hard[key])}`])) }),
  LimitRange: view('LimitRanges', [NAME, NAMESPACE, num('limits', 'Limits', (o) => arr(o.spec?.limits).length), AGE]),
  HorizontalPodAutoscaler: view(
    'HorizontalPodAutoscalers',
    [
      NAME,
      NAMESPACE,
      col('metrics', 'Metrics', (o) => hpaMetrics(o), { width: 'minmax(140px, 1.6fr)' }),
      num('min', 'Min', (o) => count(o.spec?.minReplicas ?? 1)),
      num('max', 'Max', (o) => count(o.spec?.maxReplicas)),
      num('replicas', 'Replicas', (o) => count(o.status?.currentReplicas)),
      AGE,
      status((o) => (condition(o, 'ScalingActive')?.status === 'False' || condition(o, 'AbleToScale')?.status === 'False' ? st('Not scaling', 'warning') : st('Active', 'success'))),
    ],
    {
      railColumn: 'replicas',
      status: (o) => (condition(o, 'ScalingActive')?.status === 'False' || condition(o, 'AbleToScale')?.status === 'False' ? st('Not scaling', 'warning') : st('Active', 'success')),
      details: (o) => kv(['Target', o.spec?.scaleTargetRef ? `${text(o.spec.scaleTargetRef.kind)}/${text(o.spec.scaleTargetRef.name)}` : ''], ['Metrics', hpaMetrics(o)], ['Replicas', `${count(o.status?.currentReplicas)} current, ${count(o.status?.desiredReplicas)} desired (min ${count(o.spec?.minReplicas ?? 1)}, max ${count(o.spec?.maxReplicas)})`]),
    },
  ),
  PodDisruptionBudget: view('PodDisruptionBudgets', [NAME, NAMESPACE, col('minAvailable', 'Min available', (o) => text(o.spec?.minAvailable), { width: '110px' }), col('maxUnavailable', 'Max unavailable', (o) => text(o.spec?.maxUnavailable), { width: '120px' }), num('allowed', 'Allowed', (o) => count(o.status?.disruptionsAllowed)), num('healthy', 'Healthy', (o) => ratio(o.status?.currentHealthy, o.status?.desiredHealthy)), AGE], { railColumn: 'allowed' }),
  PriorityClass: view('PriorityClasses', [NAME, num('value', 'Value', (o) => count(o.value), { width: '110px' }), col('default', 'Global default', (o) => (o.globalDefault ? 'Yes' : 'No'), { width: '110px' }), AGE], { railColumn: 'value' }),
  RuntimeClass: view('RuntimeClasses', [NAME, col('handler', 'Handler', (o) => text(o.handler), { width: 'minmax(100px, 1fr)' }), AGE], { railColumn: 'handler' }),
  Lease: view(
    'Leases',
    [NAME, NAMESPACE, col('holder', 'Holder', (o) => text(o.spec?.holderIdentity), { width: 'minmax(160px, 2fr)' }), col('renewed', 'Renewed', (o) => timeOf(o.spec?.renewTime), { cell: 'age', width: '90px', align: 'end' }), AGE],
    { railColumn: 'renewed', details: (o) => kv(['Holder', o.spec?.holderIdentity], ['Duration', o.spec?.leaseDurationSeconds ? `${text(o.spec.leaseDurationSeconds)}s` : ''], ['Renewed', o.spec?.renewTime], ['Transitions', o.spec?.leaseTransitions]) },
  ),
  MutatingWebhookConfiguration: view('MutatingWebhookConfigurations', [NAME, num('webhooks', 'Webhooks', (o) => arr(o.webhooks).length), AGE], { railColumn: 'webhooks' }),
  ValidatingWebhookConfiguration: view('ValidatingWebhookConfigurations', [NAME, num('webhooks', 'Webhooks', (o) => arr(o.webhooks).length), AGE], { railColumn: 'webhooks' }),

  Service: view(
    'Services',
    [
      NAME,
      NAMESPACE,
      col('type', 'Type', (o) => text(o.spec?.type), { width: '110px' }),
      col('clusterIp', 'Cluster IP', (o) => text(o.spec?.clusterIP), { cell: 'mono', width: 'minmax(110px, 1fr)' }),
      col('ports', 'Ports', (o) => servicePorts(o), { width: 'minmax(120px, 1.4fr)' }),
      col('externalIp', 'External IP', (o) => externalIp(o), { width: 'minmax(120px, 1.4fr)' }),
      col('selector', 'Selector', (o) => pairs(o.spec?.selector), { width: 'minmax(120px, 1.4fr)' }),
      AGE,
      status((o) => (o.spec?.type === 'LoadBalancer' && loadBalancers(o).length === 0 ? st('Pending', 'warning') : st('Active', 'success'))),
    ],
    {
      railColumn: 'type',
      status: (o) => (o.spec?.type === 'LoadBalancer' && loadBalancers(o).length === 0 ? st('Pending', 'warning') : st('Active', 'success')),
      details: (o) => kv(['Type', o.spec?.type], ['Cluster IP', o.spec?.clusterIP], ['External', externalIp(o)], ['Ports', servicePorts(o)], ['Selector', pairs(o.spec?.selector)], ['Session affinity', o.spec?.sessionAffinity]),
    },
  ),
  Endpoints: view('Endpoints', [NAME, NAMESPACE, col('endpoints', 'Endpoints', (o) => endpointsText(o), { width: 'minmax(200px, 3fr)' }), AGE], { railColumn: 'endpoints', status: (o) => (endpointsText(o) ? st('Ready', 'success') : st('No addresses', 'warning')) }),
  EndpointSlice: view('EndpointSlices', [NAME, NAMESPACE, col('addressType', 'Address type', (o) => text(o.addressType), { width: '110px' }), col('ports', 'Ports', (o) => arr(o.ports).map((p) => text(p.port)).join(', '), { width: '110px' }), num('endpoints', 'Endpoints', (o) => arr(o.endpoints).length), AGE], { railColumn: 'endpoints' }),
  Ingress: view(
    'Ingresses',
    [NAME, NAMESPACE, col('loadBalancers', 'Load balancers', (o) => more(loadBalancers(o), 2), { width: 'minmax(160px, 2fr)' }), col('rules', 'Rules', (o) => more(arr(o.spec?.rules).map((r) => text(r.host) || '*'), 2), { width: 'minmax(140px, 1.6fr)' }), AGE],
    { railColumn: 'rules', details: (o) => kv(['Class', o.spec?.ingressClassName], ['Hosts', arr(o.spec?.rules).map((r) => text(r.host) || '*').join(', ')], ['Address', loadBalancers(o).join(', ')]) },
  ),
  IngressClass: view('IngressClasses', [NAME, col('controller', 'Controller', (o) => text(o.spec?.controller), { width: 'minmax(180px, 2fr)' }), AGE], { railColumn: 'controller' }),
  NetworkPolicy: view('NetworkPolicies', [NAME, NAMESPACE, col('types', 'Policy types', (o) => (Array.isArray(o.spec?.policyTypes) ? (o.spec.policyTypes as string[]).join(', ') : ''), { width: 'minmax(120px, 1fr)' }), col('selector', 'Pod selector', (o) => pairs(o.spec?.podSelector?.matchLabels), { width: 'minmax(140px, 1.6fr)' }), AGE], { railColumn: 'types' }),

  PersistentVolumeClaim: view(
    'PersistentVolumeClaims',
    [NAME, NAMESPACE, col('storageClass', 'Storage class', (o) => text(o.spec?.storageClassName), { width: 'minmax(110px, 1fr)' }), num('size', 'Size', (o) => pvcSize(o), { sort: (o) => quantityValue(pvcSize(o)), width: '90px' }), col('volume', 'Volume', (o) => text(o.spec?.volumeName), { width: 'minmax(140px, 1.5fr)' }), AGE, status((o) => pvStatus(text(o.status?.phase)))],
    {
      railColumn: 'size',
      status: (o) => pvStatus(text(o.status?.phase)),
      details: (o) => kv(['Storage class', o.spec?.storageClassName], ['Size', pvcSize(o)], ['Access modes', Array.isArray(o.spec?.accessModes) ? (o.spec.accessModes as string[]).join(', ') : ''], ['Volume', o.spec?.volumeName], ['Volume mode', o.spec?.volumeMode]),
    },
  ),
  PersistentVolume: view(
    'PersistentVolumes',
    [NAME, col('storageClass', 'Storage class', (o) => text(o.spec?.storageClassName), { width: 'minmax(110px, 1fr)' }), num('capacity', 'Capacity', (o) => text(o.spec?.capacity?.storage), { sort: (o) => quantityValue(o.spec?.capacity?.storage), width: '90px' }), col('claim', 'Claim', (o) => (o.spec?.claimRef ? `${text(o.spec.claimRef.namespace)}/${text(o.spec.claimRef.name)}` : ''), { width: 'minmax(160px, 2fr)' }), col('reclaim', 'Reclaim', (o) => text(o.spec?.persistentVolumeReclaimPolicy), { width: '90px' }), AGE, status((o) => pvStatus(text(o.status?.phase)))],
    { railColumn: 'capacity', status: (o) => pvStatus(text(o.status?.phase)), details: (o) => kv(['Capacity', o.spec?.capacity?.storage], ['Reclaim policy', o.spec?.persistentVolumeReclaimPolicy], ['Claim', o.spec?.claimRef ? `${text(o.spec.claimRef.namespace)}/${text(o.spec.claimRef.name)}` : ''], ['Storage class', o.spec?.storageClassName]) },
  ),
  StorageClass: view('StorageClasses', [NAME, col('provisioner', 'Provisioner', (o) => text(o.provisioner), { width: 'minmax(160px, 2fr)' }), col('reclaim', 'Reclaim', (o) => text(o.reclaimPolicy), { width: '90px' }), col('default', 'Default', (o) => (isDefaultClass(o) ? 'Yes' : ''), { width: '80px' }), AGE], { railColumn: 'provisioner' }),

  Namespace: view('Namespaces', [NAME, col('labels', 'Labels', (o) => pairs(o.metadata?.labels), { width: 'minmax(160px, 3fr)' }), AGE, status((o) => (text(o.status?.phase) === 'Terminating' ? st('Terminating', 'warning') : st(text(o.status?.phase) || 'Active', 'success')))], { railColumn: 'age', status: (o) => (text(o.status?.phase) === 'Terminating' ? st('Terminating', 'warning') : st(text(o.status?.phase) || 'Active', 'success')) }),

  Event: view(
    'Events',
    [
      col('type', 'Type', (o) => text(o.type), { width: '80px' }),
      col('message', 'Message', (o) => text(o.message ?? o.note), { width: 'minmax(260px, 4fr)' }),
      NAMESPACE,
      col('object', 'Involved object', (o) => involved(o), { width: 'minmax(160px, 2fr)' }),
      col('source', 'Source', (o) => text(o.source?.component ?? o.reportingComponent), { width: 'minmax(100px, 1fr)' }),
      num('count', 'Count', (o) => count(o.count ?? o.series?.count ?? 1)),
      AGE,
      col('lastSeen', 'Last seen', (o) => eventTime(o), { cell: 'age', width: '80px', align: 'end' }),
    ],
    {
      sort: { column: 'lastSeen', dir: 'asc' },
      railColumn: 'lastSeen',
      railTitle: (o) => text(o.message ?? o.note) || text(o.reason),
      status: (o) => (text(o.type) === 'Warning' ? st('Warning', 'warning') : st(text(o.type) || 'Normal', 'info')),
      details: (o) => kv(['Reason', o.reason], ['Message', o.message ?? o.note], ['Object', involved(o)], ['Count', o.count ?? o.series?.count], ['Source', o.source?.component ?? o.reportingComponent]),
    },
  ),

  ServiceAccount: view('ServiceAccounts', [NAME, NAMESPACE, num('secrets', 'Secrets', (o) => arr(o.secrets).length), AGE], { railColumn: 'secrets' }),
  ClusterRole: view('ClusterRoles', [NAME, num('rules', 'Rules', (o) => arr(o.rules).length), AGE], { railColumn: 'rules' }),
  Role: view('Roles', [NAME, NAMESPACE, num('rules', 'Rules', (o) => arr(o.rules).length), AGE], { railColumn: 'rules' }),
  ClusterRoleBinding: view('ClusterRoleBindings', [NAME, col('subjects', 'Subjects', (o) => subjects(o), { width: 'minmax(180px, 2fr)' }), col('role', 'Role', (o) => (o.roleRef ? `${text(o.roleRef.kind)}/${text(o.roleRef.name)}` : ''), { width: 'minmax(160px, 2fr)' }), AGE], { railColumn: 'role', details: (o) => kv(['Role', o.roleRef ? `${text(o.roleRef.kind)}/${text(o.roleRef.name)}` : ''], ['Subjects', arr(o.subjects).map((s) => `${text(s.kind)}:${text(s.namespace ? `${text(s.namespace)}/` : '')}${text(s.name)}`).join(', ')]) }),
  RoleBinding: view('RoleBindings', [NAME, NAMESPACE, col('subjects', 'Subjects', (o) => subjects(o), { width: 'minmax(180px, 2fr)' }), col('role', 'Role', (o) => (o.roleRef ? `${text(o.roleRef.kind)}/${text(o.roleRef.name)}` : ''), { width: 'minmax(160px, 2fr)' }), AGE], { railColumn: 'role', details: (o) => kv(['Role', o.roleRef ? `${text(o.roleRef.kind)}/${text(o.roleRef.name)}` : ''], ['Subjects', arr(o.subjects).map((s) => `${text(s.kind)}:${text(s.name)}`).join(', ')]) }),

  CustomResourceDefinition: view('Definitions', [NAME, col('group', 'Group', (o) => text(o.spec?.group), { width: 'minmax(140px, 1.6fr)' }), col('kind', 'Kind', (o) => text(o.spec?.names?.kind), { width: 'minmax(110px, 1fr)' }), col('scope', 'Scope', (o) => text(o.spec?.scope), { width: '90px' }), col('versions', 'Versions', (o) => arr(o.spec?.versions).map((v) => text(v.name)).join(', '), { width: '90px' }), AGE], { railColumn: 'kind', details: (o) => kv(['Group', o.spec?.group], ['Kind', o.spec?.names?.kind], ['Scope', o.spec?.scope], ['Versions', arr(o.spec?.versions).map((v) => text(v.name)).join(', ')]) }),
};

function pvStatus(phase: string): StatusInfo {
  if (phase === 'Bound' || phase === 'Available') return st(phase, 'success');
  if (phase === 'Failed' || phase === 'Lost') return st(phase, 'error');
  if (!phase) return st('Unknown', 'muted');
  return st(phase, 'warning');
}

/** Every built-in kind, for tests and the navigation. */
export const VIEW_KINDS = Object.keys(VIEWS);

/** Name, Namespace, Age for a kind with no view of its own (custom resources, kinds found through discovery). */
const fallbackView = (info: Pick<KindInfo, 'kind' | 'namespaced'>): KindView => ({
  title: `${info.kind}s`,
  columns: info.namespaced ? [NAME, NAMESPACE, AGE] : [NAME, AGE],
  sort: { column: 'name', dir: 'asc' },
});

export const viewFor = (info: Pick<KindInfo, 'kind' | 'group' | 'namespaced'>): KindView => {
  const known = VIEWS[info.kind];
  const builtin = KINDS.find((kind) => kind.kind === info.kind && kind.group === info.group);
  return known && builtin ? known : fallbackView(info);
};

export const statusOf = (view: KindView, object: Obj): StatusInfo | null => (view.status ? view.status(object) : null);

/** A cell as text. Ages need the current time. */
export const cellText = (column: Column, object: Obj, now: number, ctx?: ViewContext): string => {
  const value = column.get(object, ctx);
  if (column.cell === 'age') return typeof value === 'number' ? ageText(value, now) : '';
  return value === null ? '' : String(value);
};

/** Lower-case text the search box matches against. */
export const rowText = (view: KindView, object: Obj): string =>
  view.columns
    .filter((column) => column.cell !== 'age' && column.cell !== 'containers')
    .map((column) => text(column.get(object)))
    .join(' ')
    .toLowerCase();

const empty = (value: string | number | null): boolean => value === null || value === '';

/** Sorted copy. Empty cells go last whichever way it sorts. Age sorts youngest first when `asc`. */
export const sortRows = (rows: Obj[], view: KindView, columnId: string, dir: 'asc' | 'desc', ctx?: ViewContext): Obj[] => {
  const column = view.columns.find((c) => c.id === columnId) ?? view.columns[0]!;
  const sign = (dir === 'asc' ? 1 : -1) * (column.cell === 'age' ? -1 : 1);
  const by = column.sort ?? column.get;
  const tie = (a: Obj, b: Obj): number => `${text(a.metadata?.namespace)}/${text(a.metadata?.name)}`.localeCompare(`${text(b.metadata?.namespace)}/${text(b.metadata?.name)}`);
  return [...rows].sort((a, b) => {
    const x = by(a, ctx);
    const y = by(b, ctx);
    if (empty(x) && empty(y)) return tie(a, b);
    if (empty(x)) return 1;
    if (empty(y)) return -1;
    const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return diff * sign || tie(a, b);
  });
};

// ----- Navigation

export interface NavItem {
  kind: string;
  title: string;
}

export interface NavSection {
  id: string;
  title: string;
  items: NavItem[];
  /** Draw the section title even with one item (the two Overview entries would read the same without it). */
  heading?: boolean;
}

const item = (kind: string): NavItem => ({ kind, title: VIEWS[kind]?.title ?? `${kind}s` });

/** Navigation entries that are drawn by the panel itself, not listed from the cluster. */
export const CLUSTER_OVERVIEW = 'ClusterOverview';
export const WORKLOADS_OVERVIEW = 'WorkloadsOverview';
export const OVERVIEW_KINDS: ReadonlySet<string> = new Set([CLUSTER_OVERVIEW, WORKLOADS_OVERVIEW]);
export const SPECIAL_KINDS: ReadonlySet<string> = new Set([CLUSTER_OVERVIEW, WORKLOADS_OVERVIEW, 'PortForwards', HELM_RELEASES]);

/**
 * Lens order. The entries here are fixed; `buildNav` in crds.ts adds the cluster's own custom resources after
 * Definitions and the GitOps sections (Flux, Argo CD) before Port forwarding, when their CRDs exist.
 */
export const NAV: NavSection[] = [
  { id: 'cluster', title: 'Cluster', heading: true, items: [{ kind: CLUSTER_OVERVIEW, title: 'Overview' }] },
  { id: 'nodes', title: 'Nodes', items: [item('Node')] },
  {
    id: 'workloads',
    title: 'Workloads',
    items: [{ kind: WORKLOADS_OVERVIEW, title: 'Overview' }, ...['Pod', 'Deployment', 'DaemonSet', 'StatefulSet', 'ReplicaSet', 'Job', 'CronJob'].map(item)],
  },
  {
    id: 'config',
    title: 'Config',
    items: ['ConfigMap', 'Secret', 'ResourceQuota', 'LimitRange', 'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'PriorityClass', 'RuntimeClass', 'Lease', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'].map(item),
  },
  { id: 'network', title: 'Network', items: ['Service', 'Endpoints', 'EndpointSlice', 'Ingress', 'IngressClass', 'NetworkPolicy'].map(item) },
  { id: 'storage', title: 'Storage', items: ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass'].map(item) },
  { id: 'namespaces', title: 'Namespaces', items: [item('Namespace')] },
  { id: 'events', title: 'Events', items: [item('Event')] },
  { id: 'helm', title: 'Helm', heading: true, items: [{ kind: HELM_RELEASES, title: 'Releases' }] },
  { id: 'access', title: 'Access control', items: ['ServiceAccount', 'ClusterRole', 'Role', 'ClusterRoleBinding', 'RoleBinding'].map(item) },
  { id: 'crds', title: 'Custom resources', items: [item('CustomResourceDefinition')] },
  { id: 'forwards', title: 'Port forwarding', items: [{ kind: 'PortForwards', title: 'Port forwarding' }] },
];

export const DEFAULT_KIND = CLUSTER_OVERVIEW;

/** Section title and item title for a kind, e.g. `Workloads` and `Pods`. */
export const navLabel = (kind: string): { section: string; title: string } | null => {
  for (const section of NAV) {
    const found = section.items.find((entry) => entry.kind === kind);
    if (found) return { section: section.title, title: found.title };
  }
  return null;
};


/** The small builders the registry uses, for views defined elsewhere (custom resources, GitOps). */
export const viewHelpers = { col, NAME, NAMESPACE, AGE, st, kv, condition, text, arr, pairs, trueConditions };
