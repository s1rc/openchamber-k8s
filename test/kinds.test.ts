import { describe, expect, test } from 'bun:test';
import {
  cellText,
  containerStates,
  DEFAULT_KIND,
  eventTime,
  findKind,
  findKindByApiVersion,
  isSecret,
  kindPath,
  KINDS,
  NAV,
  navLabel,
  podStatus,
  rowText,
  sortRows,
  statusOf,
  viewFor,
  type KindInfo,
} from '../src/shared/kinds.ts';
import type { Obj } from '../src/shared/types.ts';

describe('findKind', () => {
  test('matches kind, plural and short name, case-insensitive', () => {
    for (const word of ['Deployment', 'deployments', 'deploy', 'DEPLOY']) expect(findKind(word)?.kind).toBe('Deployment');
    expect(findKind('po')?.kind).toBe('Pod');
    expect(findKind('nothing')).toBeUndefined();
  });

  test('has no duplicate kinds or plurals', () => {
    expect(new Set(KINDS.map((info) => `${info.group}/${info.kind}`)).size).toBe(KINDS.length);
    expect(new Set(KINDS.map((info) => `${info.group}/${info.plural}`)).size).toBe(KINDS.length);
  });

  test('findKindByApiVersion follows the version it is given', () => {
    expect(findKindByApiVersion('apps/v1', 'Deployment')?.plural).toBe('deployments');
    expect(findKindByApiVersion('autoscaling/v1', 'HorizontalPodAutoscaler')?.version).toBe('v1');
    expect(findKindByApiVersion('v1', 'ConfigMap')?.group).toBe('');
    expect(findKindByApiVersion('example.io/v1', 'Widget')).toBeUndefined();
  });
});

describe('kindPath', () => {
  const pod = findKind('pod')!;
  const deploy = findKind('deploy')!;
  const node = findKind('node')!;

  test('core and grouped kinds', () => {
    expect(kindPath(pod, 'gm', 'api-1')).toBe('/api/v1/namespaces/gm/pods/api-1');
    expect(kindPath(deploy, 'gm')).toBe('/apis/apps/v1/namespaces/gm/deployments');
  });

  test('all namespaces and cluster-scoped kinds', () => {
    expect(kindPath(pod, null)).toBe('/api/v1/pods');
    expect(kindPath(node, 'gm', 'n1')).toBe('/api/v1/nodes/n1');
  });

  test('encodes names', () => {
    expect(kindPath(pod, 'a b', 'x/y')).toBe('/api/v1/namespaces/a%20b/pods/x%2Fy');
  });

  test('only the core Secret is a Secret', () => {
    expect(isSecret(findKind('secret')!)).toBe(true);
    expect(isSecret({ kind: 'Secret', group: 'external-secrets.io' })).toBe(false);
  });
});

const NOW = Date.parse('2026-11-11T12:00:00Z');
const infoOf = (kind: string): KindInfo => findKind(kind)!;
const navKinds = NAV.flatMap((section) => section.items.map((item) => item.kind));

describe('navigation', () => {
  test('every kind in the plan table is there, once, and has a registry entry', () => {
    const expected = [
      'Node', 'Pod', 'Deployment', 'DaemonSet', 'StatefulSet', 'ReplicaSet', 'Job', 'CronJob',
      'ConfigMap', 'Secret', 'ResourceQuota', 'LimitRange', 'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'PriorityClass', 'RuntimeClass', 'Lease', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration',
      'Service', 'Endpoints', 'EndpointSlice', 'Ingress', 'IngressClass', 'NetworkPolicy',
      'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass', 'Namespace', 'Event',
      'ServiceAccount', 'ClusterRole', 'Role', 'ClusterRoleBinding', 'RoleBinding', 'CustomResourceDefinition',
    ];
    expect([...navKinds].sort()).toEqual([...expected].sort());
    for (const kind of navKinds) expect(findKind(kind)).toBeDefined();
  });

  test('the default kind is in the navigation and has a label', () => {
    expect(navKinds).toContain(DEFAULT_KIND);
    expect(navLabel('Pod')).toEqual({ section: 'Workloads', title: 'Pods' });
    expect(navLabel('Nothing')).toBeNull();
  });
});

describe('every view', () => {
  for (const kind of navKinds) {
    test(`${kind} is well formed and survives an empty object`, () => {
      const info = infoOf(kind);
      const view = viewFor(info);
      const ids = view.columns.map((column) => column.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain(view.sort.column);
      if (view.railColumn) expect(ids).toContain(view.railColumn);
      expect(ids).toContain('age');
      const bare: Obj = { kind, metadata: { name: 'x', namespace: 'n' } };
      for (const column of view.columns) expect(typeof cellText(column, bare, NOW)).toBe('string');
      expect(() => statusOf(view, bare)).not.toThrow();
      expect(() => view.details?.(bare)).not.toThrow();
      expect(() => rowText(view, bare)).not.toThrow();
      expect(() => sortRows([bare, bare], view, view.sort.column, view.sort.dir)).not.toThrow();
    });
  }

  test('namespaced kinds offer a Namespace column and cluster kinds do not', () => {
    for (const kind of navKinds) {
      const info = infoOf(kind);
      const has = viewFor(info).columns.some((column) => column.id === 'namespace');
      if (!info.namespaced) expect(has).toBe(false);
    }
    expect(viewFor(infoOf('Pod')).columns.some((column) => column.id === 'namespace')).toBe(true);
  });

  test('a kind with no view falls back to Name, Namespace, Age', () => {
    const custom = viewFor({ kind: 'Widget', group: 'example.io', namespaced: true });
    expect(custom.columns.map((c) => c.id)).toEqual(['name', 'namespace', 'age']);
    expect(viewFor({ kind: 'Widget', group: 'example.io', namespaced: false }).columns.map((c) => c.id)).toEqual(['name', 'age']);
  });

  test('a kind of the same name in another group does not borrow a built-in view', () => {
    expect(viewFor({ kind: 'Event', group: 'events.k8s.io', namespaced: true }).columns.map((c) => c.id)).toEqual(['name', 'namespace', 'age']);
  });
});

const pod = (patch: Obj = {}): Obj => ({
  kind: 'Pod',
  metadata: { name: 'api-1', namespace: 'gm', creationTimestamp: '2026-11-09T12:00:00Z' },
  spec: { nodeName: 'ip-1', containers: [{ name: 'app' }, { name: 'side' }] },
  status: {
    phase: 'Running',
    qosClass: 'Burstable',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [
      { name: 'app', ready: true, restartCount: 2, state: { running: {} } },
      { name: 'side', ready: true, restartCount: 1, state: { running: {} } },
    ],
  },
  ...patch,
});

describe('pod status', () => {
  test('running and ready is green, running but not ready is a warning', () => {
    expect(podStatus(pod())).toEqual({ label: 'Running', tone: 'success' });
    const notReady = pod({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ name: 'app', ready: false, state: { running: {} } }] } });
    expect(podStatus(notReady)).toEqual({ label: 'Running', tone: 'warning' });
  });

  test('names the container problem', () => {
    const crash = pod({ status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } });
    expect(podStatus(crash)).toEqual({ label: 'CrashLoopBackOff', tone: 'error' });
    const pull = pod({ status: { phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ImagePullBackOff' } } }] } });
    expect(podStatus(pull).tone).toBe('error');
    const oom = pod({ status: { phase: 'Running', containerStatuses: [{ name: 'app', state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] } });
    expect(podStatus(oom)).toEqual({ label: 'OOMKilled', tone: 'error' });
    const exit = pod({ status: { phase: 'Failed', containerStatuses: [{ name: 'app', state: { terminated: { exitCode: 2 } } }] } });
    expect(podStatus(exit).label).toBe('ExitCode:2');
  });

  test('pending, init, completed and terminating', () => {
    expect(podStatus(pod({ status: { phase: 'Pending' } }))).toEqual({ label: 'Pending', tone: 'info' });
    const init = pod({ status: { phase: 'Pending', initContainerStatuses: [{ name: 'i', state: { waiting: { reason: 'PodInitializing' } } }] } });
    expect(podStatus(init)).toEqual({ label: 'Init:0/1', tone: 'info' });
    const initFail = pod({ status: { phase: 'Pending', initContainerStatuses: [{ name: 'i', state: { terminated: { reason: 'Error', exitCode: 1 } } }] } });
    expect(podStatus(initFail)).toEqual({ label: 'Init:Error', tone: 'error' });
    const done = pod({ status: { phase: 'Succeeded', containerStatuses: [{ name: 'app', state: { terminated: { reason: 'Completed', exitCode: 0 } } }] } });
    expect(podStatus(done)).toEqual({ label: 'Completed', tone: 'muted' });
    const going = pod({ metadata: { name: 'x', deletionTimestamp: '2026-11-11T11:59:00Z' } });
    expect(podStatus(going)).toEqual({ label: 'Terminating', tone: 'warning' });
  });

  test('container dots follow each container', () => {
    expect(containerStates(pod()).map((s) => s.tone)).toEqual(['success', 'success']);
    const mixed = pod({ status: { containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } });
    expect(containerStates(mixed)).toEqual([
      { name: 'app', tone: 'error', state: 'CrashLoopBackOff' },
      { name: 'side', tone: 'muted', state: 'Unknown' },
    ]);
  });

  test('pod cells', () => {
    const view = viewFor(infoOf('Pod'));
    const text = Object.fromEntries(view.columns.map((c) => [c.id, cellText(c, pod(), NOW)]));
    expect(text).toMatchObject({ name: 'api-1', namespace: 'gm', containers: '2', restarts: '3', node: 'ip-1', qos: 'Burstable', age: '2d', status: 'Running' });
  });
});

describe('other statuses and cells', () => {
  test('deployment ratio, status and conditions', () => {
    const view = viewFor(infoOf('Deployment'));
    const deploy = { kind: 'Deployment', metadata: { name: 'd', namespace: 'gm' }, spec: { replicas: 3 }, status: { readyReplicas: 2, conditions: [{ type: 'Available', status: 'True' }, { type: 'Progressing', status: 'True' }] } };
    expect(cellText(view.columns.find((c) => c.id === 'pods')!, deploy, NOW)).toBe('2/3');
    expect(cellText(view.columns.find((c) => c.id === 'conditions')!, deploy, NOW)).toBe('Available, Progressing');
    expect(statusOf(view, deploy)).toEqual({ label: 'Updating', tone: 'info' });
    expect(statusOf(view, { ...deploy, spec: { replicas: 0 } })?.label).toBe('Scaled to 0');
    expect(statusOf(view, { ...deploy, status: { readyReplicas: 3 } })).toEqual({ label: 'Available', tone: 'success' });
    expect(statusOf(view, { ...deploy, status: { conditions: [{ type: 'Available', status: 'False' }] } })?.tone).toBe('error');
  });

  test('daemon set status uses its own counters', () => {
    const view = viewFor(infoOf('DaemonSet'));
    const ds = { metadata: { name: 'aws-node' }, status: { numberReady: 6, desiredNumberScheduled: 6 } };
    expect(statusOf(view, ds)).toEqual({ label: 'Ready', tone: 'success' });
  });

  test('node roles, size columns and status', () => {
    const view = viewFor(infoOf('Node'));
    const node = {
      metadata: { name: 'n1', labels: { 'node-role.kubernetes.io/control-plane': '' } },
      spec: { taints: [{ key: 'a', effect: 'NoSchedule' }] },
      status: { allocatable: { cpu: '1930m', memory: '16Gi', 'ephemeral-storage': '47Gi' }, conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.34.12' } },
    };
    const cell = (id: string): string => cellText(view.columns.find((c) => c.id === id)!, node, NOW);
    expect(cell('roles')).toBe('control-plane');
    expect(cell('cpu')).toBe('1.93');
    expect(cell('memory')).toBe('16 GiB');
    expect(cell('taints')).toBe('1');
    expect(cell('status')).toBe('Ready');
    expect(statusOf(view, { ...node, spec: { unschedulable: true } })?.tone).toBe('warning');
    expect(statusOf(view, { ...node, status: { conditions: [] } })).toEqual({ label: 'NotReady', tone: 'error' });
  });

  test('service ports, load balancer and selector', () => {
    const view = viewFor(infoOf('Service'));
    const svc = { metadata: { name: 's' }, spec: { type: 'LoadBalancer', clusterIP: '10.0.0.1', ports: [{ port: 80, nodePort: 30080, protocol: 'TCP' }], selector: { app: 'x', tier: 'web' } }, status: { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }] } } };
    const cell = (id: string): string => cellText(view.columns.find((c) => c.id === id)!, svc, NOW);
    expect(cell('ports')).toBe('80:30080/TCP');
    expect(cell('externalIp')).toBe('lb.example.com');
    expect(cell('selector')).toBe('app=x, tier=web');
    expect(statusOf(view, { ...svc, status: {} })).toEqual({ label: 'Pending', tone: 'warning' });
  });

  test('event time falls back through the fields events use', () => {
    expect(eventTime({ lastTimestamp: '2026-11-11T11:00:00Z' })).toBe(Date.parse('2026-11-11T11:00:00Z'));
    expect(eventTime({ eventTime: '2026-11-11T10:00:00Z' })).toBe(Date.parse('2026-11-11T10:00:00Z'));
    expect(eventTime({ metadata: { creationTimestamp: '2026-11-11T09:00:00Z' } })).toBe(Date.parse('2026-11-11T09:00:00Z'));
    expect(statusOf(viewFor(infoOf('Event')), { type: 'Warning' })).toEqual({ label: 'Warning', tone: 'warning' });
  });

  test('a lease shows how long ago it was renewed', () => {
    const view = viewFor(infoOf('Lease'));
    const lease = { metadata: { name: 'ip-1', namespace: 'kube-node-lease', creationTimestamp: '2026-11-01T12:00:00Z' }, spec: { holderIdentity: 'ip-1', renewTime: '2026-11-11T11:59:50Z' } };
    expect(cellText(view.columns.find((c) => c.id === 'renewed')!, lease, NOW)).toBe('10s');
  });
});

describe('secrets stay masked in the panel', () => {
  const secret = { kind: 'Secret', metadata: { name: 'db', namespace: 'gm' }, type: 'Opaque', data: { password: '<redacted, 8 bytes>', user: '<redacted, 3 bytes>' } };

  test('keys are listed and nothing derived from the registry holds a value', () => {
    const view = viewFor(infoOf('Secret'));
    expect(cellText(view.columns.find((c) => c.id === 'keys')!, secret, NOW)).toBe('2');
    expect(view.details?.(secret)).toContainEqual(['Keys', 'password, user']);
  });

  test('a Secret from another group does not get the Secret view', () => {
    expect(viewFor({ kind: 'Secret', group: 'external-secrets.io', namespaced: true }).columns.map((c) => c.id)).toEqual(['name', 'namespace', 'age']);
  });
});

describe('sorting', () => {
  const view = viewFor(infoOf('Pod'));
  const a = pod({ metadata: { name: 'a', namespace: 'z', creationTimestamp: '2026-11-01T00:00:00Z' } });
  const b = pod({ metadata: { name: 'b', namespace: 'y', creationTimestamp: '2026-11-10T00:00:00Z' } });
  const c = pod({ metadata: { name: 'c', namespace: 'x' }, status: { containerStatuses: [{ name: 'app', restartCount: 9 }] } });
  const names = (rows: Obj[]): string[] => rows.map((row) => row.metadata.name);

  test('by name, both ways', () => {
    expect(names(sortRows([c, a, b], view, 'name', 'asc'))).toEqual(['a', 'b', 'c']);
    expect(names(sortRows([c, a, b], view, 'name', 'desc'))).toEqual(['c', 'b', 'a']);
  });

  test('numbers sort as numbers', () => {
    expect(names(sortRows([a, c, b], view, 'restarts', 'desc'))[0]).toBe('c');
    const ten = { ...b, metadata: { name: 'pod-10', namespace: 'y' } };
    const two = { ...b, metadata: { name: 'pod-2', namespace: 'y' } };
    expect(names(sortRows([ten, two], view, 'name', 'asc'))).toEqual(['pod-2', 'pod-10']);
  });

  test('age sorts the youngest first when ascending, and rows with no age go last', () => {
    expect(names(sortRows([a, b, c], view, 'age', 'asc'))).toEqual(['b', 'a', 'c']);
    expect(names(sortRows([a, b, c], view, 'age', 'desc'))).toEqual(['a', 'b', 'c']);
  });

  test('size columns sort by value, not by text', () => {
    const nodes = viewFor(infoOf('Node'));
    const small = { metadata: { name: 'small' }, status: { allocatable: { memory: '900Mi' } } };
    const big = { metadata: { name: 'big' }, status: { allocatable: { memory: '16Gi' } } };
    expect(names(sortRows([big, small], nodes, 'memory', 'asc'))).toEqual(['small', 'big']);
  });

  test('search text covers the cells but not the age', () => {
    const text = rowText(view, pod());
    expect(text).toContain('api-1');
    expect(text).toContain('burstable');
    expect(text).toContain('running');
    expect(text).not.toContain('2d');
  });
});
