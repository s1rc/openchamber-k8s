import { describe, expect, test } from 'bun:test';
import { cpuText, parseQuantity, percentText, rateText } from '../src/shared/format.ts';
import { cellText, findKind, nodeMeter, sortRows, viewFor } from '../src/shared/kinds.ts';
import { compactNodeMetrics, compactPodMetrics, emptyUsage, kubeletDisk, podUsageKey, usageFromReply, usageNote } from '../src/shared/metrics.ts';
import { statusFromError } from '../src/service/metrics.ts';
import { K8sError } from '../src/service/errors.ts';
import type { Obj } from '../src/shared/types.ts';

describe('quantities from metrics-server', () => {
  test('nanocores, microcores and millicores', () => {
    expect(parseQuantity('250000000n')).toBeCloseTo(0.25);
    expect(parseQuantity('1500000u')).toBeCloseTo(1.5);
    expect(parseQuantity('128m')).toBeCloseTo(0.128);
    expect(parseQuantity('4410Mi')).toBe(4410 * 1024 * 1024);
    expect(parseQuantity('1Ki')).toBe(1024);
  });

  test('cpu, percent and rate text', () => {
    expect(cpuText(0.0124)).toBe('12m');
    expect(cpuText(0)).toBe('0m');
    expect(cpuText(1.5)).toBe('1.5');
    expect(cpuText(null)).toBe('');
    expect(percentText(0.2349)).toBe('23%');
    expect(percentText(null)).toBe('');
    expect(rateText(1536)).toBe('1.5 KiB/s');
    expect(rateText(null)).toBe('');
  });
});

describe('compacting metrics-server answers', () => {
  test('nodes', () => {
    const rows = compactNodeMetrics({
      items: [
        { metadata: { name: 'n1' }, timestamp: '2026-11-11T12:00:00Z', usage: { cpu: '256000000n', memory: '4410Mi' } },
        { metadata: { name: '' }, usage: {} },
        { metadata: { name: 'n2' }, usage: { cpu: '65m' } },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'n1', cpu: 0.256, memory: 4410 * 1024 * 1024, at: Date.parse('2026-11-11T12:00:00Z') });
    expect(rows[1]!.memory).toBeNull();
    expect(rows[1]!.cpu).toBeCloseTo(0.065);
  });

  test('pods add their containers together', () => {
    const rows = compactPodMetrics({
      items: [
        { metadata: { name: 'p', namespace: 'gm' }, containers: [{ usage: { cpu: '10m', memory: '100Mi' } }, { usage: { cpu: '5m', memory: '28Mi' } }] },
        { metadata: { name: 'empty', namespace: 'gm' }, containers: [] },
      ],
    });
    expect(rows[0]!.cpu).toBeCloseTo(0.015);
    expect(rows[0]!.memory).toBe(128 * 1024 * 1024);
    expect(rows[1]).toMatchObject({ cpu: null, memory: null });
    expect(compactPodMetrics({})).toEqual([]);
  });

  test('kubelet disk', () => {
    expect(kubeletDisk({ node: { fs: { usedBytes: 10, capacityBytes: 40 } } })).toEqual({ used: 10, capacity: 40 });
    expect(kubeletDisk({ node: { fs: { usedBytes: 10 } } })).toBeNull();
    expect(kubeletDisk({})).toBeNull();
  });

  test('the reply becomes maps, and a missing metrics-server reads as a note, not an error', () => {
    const set = usageFromReply({ status: 'ok', at: 5, nodes: [{ name: 'n1', cpu: 1, memory: 2, diskUsed: 3, diskCapacity: 4 }], pods: [{ namespace: 'gm', name: 'p', cpu: 0.1, memory: 9 }] });
    expect(set.nodes.get('n1')).toEqual({ cpu: 1, memory: 2, diskUsed: 3, diskCapacity: 4 });
    expect(set.pods.get(podUsageKey('gm', 'p'))).toEqual({ cpu: 0.1, memory: 9 });
    expect(usageNote(usageFromReply({ status: 'missing' }))).toBe('Install metrics-server for usage');
    expect(usageNote(emptyUsage('loading'))).toBe('');
    expect(usageNote(set)).toBe('');
  });
});

describe('the metrics status of a failure', () => {
  const fail = (code: ConstructorParameters<typeof K8sError>[0], status?: number): K8sError => {
    const error = new K8sError(code, 'x');
    if (status) error.status = status;
    return error;
  };

  test('no API group, no permission and a metrics-server that is down are answers', () => {
    expect(statusFromError(fail('NOT_FOUND', 404))?.status).toBe('missing');
    expect(statusFromError(fail('FORBIDDEN', 403))?.status).toBe('forbidden');
    expect(statusFromError(fail('K8S_ERROR', 503))?.status).toBe('unavailable');
  });

  test('a sign in or network failure stays an error', () => {
    expect(statusFromError(fail('AUTH_EXPIRED', 401))).toBeNull();
    expect(statusFromError(fail('UNREACHABLE'))).toBeNull();
    expect(statusFromError(new Error('boom'))).toBeNull();
  });
});

const node = (name: string): Obj => ({ kind: 'Node', metadata: { name }, status: { allocatable: { cpu: '2', memory: '8Gi', 'ephemeral-storage': '50Gi' } } });

describe('usage in the Node and Pod columns', () => {
  const view = viewFor(findKind('node')!);
  const column = (id: string) => view.columns.find((c) => c.id === id)!;
  const usage = usageFromReply({
    status: 'ok',
    nodes: [
      { name: 'a', cpu: 0.5, memory: 2 * 1024 ** 3, diskUsed: 10 * 1024 ** 3, diskCapacity: 40 * 1024 ** 3 },
      { name: 'b', cpu: 1.5, memory: 1024 ** 3, diskUsed: null, diskCapacity: null },
    ],
  });
  const ctx = { usage };

  test('without usage a node shows what it can allocate', () => {
    expect(cellText(column('cpu'), node('a'), 0)).toBe('2');
    expect(cellText(column('memory'), node('a'), 0)).toBe('8 GiB');
    expect(cellText(column('disk'), node('a'), 0)).toBe('50 GiB');
    expect(nodeMeter(node('a'), undefined, 'cpu')).toBeNull();
  });

  test('with usage it shows used of allocatable and how full it is', () => {
    expect(cellText(column('cpu'), node('a'), 0, ctx)).toBe('0.5 / 2');
    expect(nodeMeter(node('a'), ctx, 'cpu')?.fraction).toBeCloseTo(0.25);
    expect(cellText(column('memory'), node('a'), 0, ctx)).toBe('2 GiB / 8 GiB');
    expect(nodeMeter(node('a'), ctx, 'disk')?.fraction).toBeCloseTo(0.25);
    expect(cellText(column('disk'), node('a'), 0, ctx)).toBe('10 GiB / 40 GiB');
  });

  test('a node metrics-server has not measured yet shows a dash, not a bare size', () => {
    expect(cellText(column('cpu'), node('new'), 0, ctx)).toBe('- / 2');
    expect(cellText(column('memory'), node('new'), 0, ctx)).toBe('- / 8 GiB');
    expect(cellText(column('cpu'), node('new'), 0, { usage: usageFromReply({ status: 'missing' }) })).toBe('2');
    const withDisks = { usage: usageFromReply({ status: 'ok', diskStatus: 'ok', nodes: [] }) };
    expect(cellText(column('disk'), node('new'), 0, withDisks)).toBe('- / 50 GiB');
  });

  test('a node whose disk could not be read falls back to allocatable', () => {
    expect(nodeMeter(node('b'), ctx, 'disk')).toBeNull();
    expect(cellText(column('disk'), node('b'), 0, ctx)).toBe('50 GiB');
  });

  test('sorting by CPU follows usage', () => {
    const sorted = sortRows([node('a'), node('b')], view, 'cpu', 'desc', ctx);
    expect(sorted.map((n) => n.metadata.name)).toEqual(['b', 'a']);
  });

  test('pod CPU and memory come from the pod usage map', () => {
    const podView = viewFor(findKind('pod')!);
    const pod: Obj = { kind: 'Pod', metadata: { name: 'p', namespace: 'gm' } };
    const podUsage = usageFromReply({ status: 'ok', pods: [{ namespace: 'gm', name: 'p', cpu: 0.012, memory: 64 * 1024 * 1024 }] });
    const cpu = podView.columns.find((c) => c.id === 'cpu')!;
    const memory = podView.columns.find((c) => c.id === 'memory')!;
    expect(cellText(cpu, pod, 0, { usage: podUsage })).toBe('12m');
    expect(cellText(memory, pod, 0, { usage: podUsage })).toBe('64 MiB');
    expect(cellText(cpu, pod, 0)).toBe('');
    expect(cellText(cpu, { kind: 'Pod', metadata: { name: 'other', namespace: 'gm' } }, 0, { usage: podUsage })).toBe('');
  });
});
