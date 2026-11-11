// Kind registry. Phase 1 only needs API paths; Phase 2 adds columns, status and actions to the same entries.

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
