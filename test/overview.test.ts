import { describe, expect, test } from 'bun:test';
import { barTone, clusterTotals, fractionOf, holdsRoom, podRequests, summarize, warningEvents } from '../src/shared/overview.ts';
import type { NodeUsage } from '../src/shared/metrics.ts';
import type { Obj } from '../src/shared/types.ts';

const MI = 1024 ** 2;
const node = (name: string, patch: Obj = {}): Obj => ({
  kind: 'Node',
  metadata: { name },
  spec: {},
  status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '3920m', memory: `${8 * 1024}Mi`, pods: '110' }, capacity: { cpu: '4', memory: `${8 * 1024 + 256}Mi`, pods: '110' } },
  ...patch,
});
const pod = (name: string, containers: Obj[], patch: Obj = {}): Obj => ({
  kind: 'Pod',
  metadata: { name, namespace: 'gm' },
  spec: { nodeName: 'n1', containers },
  status: { phase: 'Running' },
  ...patch,
});
const c = (cpu?: string, memory?: string, limits?: Obj): Obj => ({ name: 'app', resources: { requests: { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) }, ...(limits ? { limits } : {}) } });

describe('podRequests', () => {
  test('adds containers together', () => {
    const room = podRequests(pod('p', [c('100m', '128Mi', { cpu: '500m', memory: '256Mi' }), c('250m', '64Mi')]));
    expect(room.cpuRequests).toBeCloseTo(0.35);
    expect(room.memoryRequests).toBe(192 * MI);
    expect(room.cpuLimits).toBeCloseTo(0.5);
    expect(room.memoryLimits).toBe(256 * MI);
  });

  test('a big init container counts when it asks for more than the containers', () => {
    const p = pod('p', [c('100m', '100Mi')]);
    p.spec.initContainers = [c('1', '50Mi')];
    const room = podRequests(p);
    expect(room.cpuRequests).toBe(1);
    expect(room.memoryRequests).toBe(100 * MI);
  });

  test('a sidecar init container keeps its share for the whole life of the pod', () => {
    const p = pod('p', [c('100m', '100Mi')]);
    p.spec.initContainers = [{ ...c('200m', '10Mi'), restartPolicy: 'Always' }];
    expect(podRequests(p).cpuRequests).toBeCloseTo(0.3);
  });

  test('pod overhead is added and a pod with nothing asks for nothing', () => {
    const p = pod('p', [c('100m')]);
    p.spec.overhead = { cpu: '50m', memory: '10Mi' };
    expect(podRequests(p).cpuRequests).toBeCloseTo(0.15);
    expect(podRequests(p).memoryRequests).toBe(10 * MI);
    expect(podRequests(pod('q', [{ name: 'x' }])).cpuRequests).toBe(0);
  });
});

describe('holdsRoom', () => {
  test('scheduled and not finished', () => {
    expect(holdsRoom(pod('p', []))).toBe(true);
    expect(holdsRoom(pod('p', [], { status: { phase: 'Succeeded' } }))).toBe(false);
    expect(holdsRoom(pod('p', [], { status: { phase: 'Failed' } }))).toBe(false);
    expect(holdsRoom(pod('p', [], { spec: { containers: [] } }))).toBe(false);
  });
});

describe('clusterTotals', () => {
  const nodes = [node('n1'), node('n2', { spec: { unschedulable: true } }), node('n3', { status: { conditions: [{ type: 'Ready', status: 'False' }], allocatable: { cpu: '2', memory: '1Gi', pods: '20' }, capacity: { cpu: '2', memory: '1Gi', pods: '20' } } })];
  const pods = [pod('a', [c('1', '1Gi')]), pod('b', [c('500m', '512Mi')]), pod('done', [c('4')], { status: { phase: 'Succeeded' } }), pod('waiting', [c('2')], { spec: { containers: [c('2')] }, status: { phase: 'Pending' } })];

  test('counts nodes, capacity, requests and pods', () => {
    const totals = clusterTotals(nodes, pods, null);
    expect(totals.nodes).toEqual({ total: 3, ready: 2, notReady: 1, cordoned: 1 });
    expect(totals.cpu.allocatable).toBeCloseTo(3.92 * 2 + 2);
    expect(totals.cpu.capacity).toBeCloseTo(10);
    expect(totals.cpu.requests).toBeCloseTo(1.5);
    expect(totals.memory.requests).toBe(1.5 * 1024 * MI);
    expect(totals.pods.allocatable).toBe(240);
    expect(totals.pods.scheduled).toBe(2);
    expect(totals.pods.running).toBe(2);
    expect(totals.pods.pending).toBe(1);
  });

  test('usage is the sum over the nodes that were measured, and null when none were', () => {
    expect(clusterTotals(nodes, pods, null).cpu.usage).toBeNull();
    expect(clusterTotals(nodes, pods, new Map()).cpu.usage).toBeNull();
    const usage = new Map<string, NodeUsage>([
      ['n1', { cpu: 0.256, memory: 4 * 1024 * MI, diskUsed: null, diskCapacity: null }],
      ['n2', { cpu: 0.128, memory: 2 * 1024 * MI, diskUsed: null, diskCapacity: null }],
    ]);
    const totals = clusterTotals(nodes, pods, usage);
    expect(totals.cpu.usage).toBeCloseTo(0.384);
    expect(totals.memory.usage).toBe(6 * 1024 * MI);
  });

  test('an empty cluster is all zeros', () => {
    const totals = clusterTotals([], [], null);
    expect(totals.nodes.total).toBe(0);
    expect(totals.cpu).toEqual({ allocatable: 0, capacity: 0, requests: 0, limits: 0, usage: null });
  });
});

describe('fractions and tones', () => {
  test('fractionOf', () => {
    expect(fractionOf(1, 4)).toBe(0.25);
    expect(fractionOf(null, 4)).toBeNull();
    expect(fractionOf(1, 0)).toBeNull();
  });

  test('the bar turns amber at 75% and red at 90%', () => {
    expect(barTone(0.5)).toBe('primary');
    expect(barTone(0.75)).toBe('warning');
    expect(barTone(0.9)).toBe('error');
    expect(barTone(null)).toBe('primary');
  });
});

describe('summarize', () => {
  test('pods by how they are doing', () => {
    const running = pod('a', [], { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });
    const pending = pod('b', [], { status: { phase: 'Pending' } });
    const crashing = pod('c', [], { status: { phase: 'Running', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CrashLoopBackOff' } } }] } });
    const done = pod('d', [], { status: { phase: 'Succeeded' } });
    const summary = summarize('Pod', [running, running, pending, crashing, done]);
    expect(summary.total).toBe(5);
    expect(summary.parts.map((part) => part.text)).toEqual(['2 running', '1 pending', '1 failed', '1 completed']);
  });

  test('deployments and replica sets', () => {
    const deployment = (ready: number, desired: number): Obj => ({ kind: 'Deployment', metadata: { name: 'd' }, spec: { replicas: desired }, status: { readyReplicas: ready } });
    const summary = summarize('Deployment', [deployment(2, 2), deployment(1, 2), deployment(0, 2), deployment(0, 0)]);
    expect(summary.parts.map((part) => part.text)).toEqual(['1 healthy', '1 in progress', '1 failing', '1 idle']);
    const rs = summarize('ReplicaSet', [{ spec: { replicas: 0 }, status: {} }, { spec: { replicas: 2 }, status: { readyReplicas: 2 } }]);
    expect(rs.parts.map((part) => part.text)).toEqual(['1 healthy', '1 idle']);
  });

  test('an empty list has no parts', () => {
    expect(summarize('Job', [])).toEqual({ total: 0, parts: [] });
  });
});

describe('warningEvents', () => {
  const event = (name: string, type: string, at: string, extra: Obj = {}): Obj => ({
    metadata: { name, namespace: 'gm' },
    type,
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    involvedObject: { kind: 'Pod', name: 'api-1' },
    lastTimestamp: at,
    ...extra,
  });

  test('keeps warnings, newest first, up to the limit', () => {
    const list = warningEvents(
      [event('a', 'Warning', '2026-11-11T10:00:00Z'), event('b', 'Normal', '2026-11-11T12:00:00Z'), event('c', 'Warning', '2026-11-11T11:00:00Z'), event('d', 'Warning', '2026-11-11T09:00:00Z')],
      2,
    );
    expect(list.map((e) => e.key)).toEqual(['gm/c', 'gm/a']);
    expect(list[0]).toMatchObject({ reason: 'BackOff', object: 'Pod/api-1', namespace: 'gm', count: 1 });
  });

  test('reads the newer event shape and a missing object', () => {
    const [one] = warningEvents([{ metadata: { name: 'x', namespace: 'n' }, type: 'Warning', reason: 'R', note: 'hello', regarding: { kind: 'Node', name: 'n1' }, series: { count: 4, lastObservedTime: '2026-11-11T10:00:00Z' } }], 5);
    expect(one).toMatchObject({ message: 'hello', object: 'Node/n1', count: 4 });
    expect(warningEvents([{ type: 'Warning' }], 5)[0]!.object).toBe('');
  });
});
