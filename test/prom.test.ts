import { describe, expect, test } from 'bun:test';
import {
  areaPath,
  boundsOf,
  chartSpecs,
  chartTargetOf,
  escapeRegex,
  limitSeries,
  linePath,
  nearestIndex,
  niceMax,
  niceMaxFor,
  nodeInstancePattern,
  parsePromService,
  parseRange,
  promCandidates,
  promString,
  proxyBase,
  valueText,
  workloadPodPattern,
  type Series,
} from '../src/shared/prom.ts';
import type { Obj } from '../src/shared/types.ts';

const svc = (namespace: string, name: string, labels: Obj = {}, ports: Obj[] = [{ name: 'http', port: 80, protocol: 'TCP' }], spec: Obj = {}): Obj => ({
  metadata: { namespace, name, labels },
  spec: { ports, ...spec },
});

describe('promCandidates', () => {
  test('the staging layout: prometheus-server is found, its companions are not', () => {
    const found = promCandidates([
      svc('kube-system', 'prometheus-server', { 'app.kubernetes.io/name': 'prometheus', 'app.kubernetes.io/component': 'server' }),
      svc('kube-system', 'prometheus-adapter', { 'app.kubernetes.io/name': 'prometheus-adapter' }, [{ name: 'https', port: 443 }]),
      svc('kube-system', 'prometheus-kube-state-metrics', { 'app.kubernetes.io/name': 'kube-state-metrics' }, [{ port: 8080 }]),
      svc('kube-system', 'prometheus-prometheus-node-exporter', { 'app.kubernetes.io/name': 'prometheus-node-exporter' }, [{ port: 9100 }]),
      svc('default', 'kubernetes', {}, [{ port: 443 }]),
    ]);
    expect(found).toEqual([{ namespace: 'kube-system', name: 'prometheus-server', port: '80' }]);
  });

  test('kube-prometheus-stack: the server and prometheus-operated, not the operator or alertmanager', () => {
    const found = promCandidates([
      svc('monitoring', 'kube-prometheus-stack-operator', { 'app.kubernetes.io/name': 'kube-prometheus-stack-prometheus-operator' }, [{ name: 'https', port: 443 }]),
      svc('monitoring', 'kube-prometheus-stack-alertmanager', { 'app.kubernetes.io/name': 'alertmanager' }, [{ name: 'http-web', port: 9093 }]),
      svc('monitoring', 'prometheus-operated', {}, [{ name: 'http-web', port: 9090 }], { clusterIP: 'None' }),
      svc('monitoring', 'kube-prometheus-stack-prometheus', { 'app.kubernetes.io/name': 'kube-prometheus-stack-prometheus' }, [{ name: 'http-web', port: 9090 }, { name: 'reloader-web', port: 8080 }]),
    ]);
    expect(found.map((f) => f.name)).toEqual(['kube-prometheus-stack-prometheus', 'prometheus-operated']);
    expect(found[0]!.port).toBe('9090');
  });

  test('a plain Service named prometheus is found; ports prefer the web port, then 9090, then 80', () => {
    expect(promCandidates([svc('obs', 'prometheus', {}, [{ name: 'metrics', port: 8081 }, { name: 'web', port: 9999 }])])[0]!.port).toBe('9999');
    expect(promCandidates([svc('obs', 'prometheus', {}, [{ port: 8081 }, { port: 9090 }])])[0]!.port).toBe('9090');
    expect(promCandidates([svc('obs', 'prometheus', {}, [{ port: 53, protocol: 'UDP' }])])).toEqual([]);
  });

  test('nothing that looks like Prometheus gives an empty list', () => {
    expect(promCandidates([svc('a', 'api'), svc('b', 'grafana', { 'app.kubernetes.io/name': 'grafana' })])).toEqual([]);
    expect(promCandidates([])).toEqual([]);
  });
});

describe('parsePromService', () => {
  test('accepts a name and a port number or name', () => {
    expect(parsePromService({ namespace: 'monitoring', service: 'prometheus-server', port: 80 })).toEqual({ namespace: 'monitoring', name: 'prometheus-server', port: '80' });
    expect(parsePromService({ namespace: 'monitoring', service: 'prom', port: 'http-web' })).toEqual({ namespace: 'monitoring', name: 'prom', port: 'http-web' });
  });

  test('says what is wrong in words', () => {
    expect(parsePromService({ namespace: '', service: 'x', port: '1' })).toMatch(/namespace/);
    expect(parsePromService({ namespace: 'a', service: 'Bad Name', port: '1' })).toMatch(/name/);
    expect(parsePromService({ namespace: 'a', service: 'x', port: '../..' })).toMatch(/port/);
    expect(parsePromService({ namespace: 'a/b', service: 'x', port: '1' })).toMatch(/namespace/);
  });

  test('proxyBase builds the service proxy path and encodes parts', () => {
    expect(proxyBase({ namespace: 'kube-system', name: 'prometheus-server', port: '80' })).toBe('/api/v1/namespaces/kube-system/services/prometheus-server:80/proxy');
  });
});

describe('queries', () => {
  test('a pod: one series per container for CPU and memory, totals for the network', () => {
    const specs = chartSpecs({ scope: 'pod', namespace: 'gm', name: 'api-1' });
    expect(specs.map((s) => s.id)).toEqual(['cpu', 'memory', 'network', 'filesystem']);
    expect(specs[0]!.queries[0]!.query).toBe('sum by (container) (rate(container_cpu_usage_seconds_total{namespace="gm",pod="api-1",container!="",container!="POD"}[5m]))');
    expect(specs[0]!.queries[0]!.by).toBe('container');
    expect(specs[1]!.queries[0]!.query).toContain('container_memory_working_set_bytes{namespace="gm",pod="api-1"');
    expect(specs[2]!.queries.map((q) => q.name)).toEqual(['Received', 'Sent']);
    expect(specs[3]!.queries[0]!.query).toContain('container_fs_usage_bytes');
    expect(specs[3]!.fallback?.queries[0]!.query).toContain('kubelet_container_log_filesystem_used_bytes{namespace="gm",pod="api-1"');
    expect(specs[3]!.fallback?.note).toMatch(/log files/);
    expect(specs[0]!.fallback).toBeUndefined();
  });

  test('a workload matches its pods by name and sums them', () => {
    const specs = chartSpecs({ scope: 'workload', kind: 'Deployment', namespace: 'gm', name: 'api.v2' });
    expect(specs[0]!.queries[0]!.query).toBe('sum (rate(container_cpu_usage_seconds_total{namespace="gm",pod=~"api\\\\.v2-[^-]+-[^-]+",container!="",container!="POD"}[5m]))');
    expect(specs[0]!.queries[0]!.by).toBeUndefined();
    expect(() => chartSpecs({ scope: 'workload', kind: 'Service', namespace: 'gm', name: 'x' })).toThrow();
  });

  test('a node is matched by name or address', () => {
    const specs = chartSpecs({ scope: 'node', name: 'ip-10-0-20-63.ec2.internal', addresses: ['10.0.20.63'] });
    expect(specs[0]!.unit).toBe('percent');
    expect(specs[0]!.queries[0]!.query).toContain('instance=~"(ip-10-0-20-63\\\\.ec2\\\\.internal|10\\\\.0\\\\.20\\\\.63)(:[0-9]+)?"');
    expect(specs[2]!.queries[0]!.query).toContain('device!~"lo|veth.*');
    expect(specs[3]!.queries[0]!.query).toContain('mountpoint="/"');
  });

  test('quotes, backslashes and newlines in a name cannot leave their string', () => {
    expect(promString('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(() => chartSpecs({ scope: 'pod', namespace: 'gm', name: 'x"} or vector(1) #' })).toThrow();
    expect(() => chartSpecs({ scope: 'pod', namespace: 'g"m', name: 'x' })).toThrow();
    expect(() => chartSpecs({ scope: 'pod', namespace: 'gm', name: '' })).toThrow();
    const specs = chartSpecs({ scope: 'node', name: 'n', addresses: ['1.1.1.1', 'bad"address'] });
    expect(specs[0]!.queries[0]!.query).not.toContain('bad');
  });

  test('workload patterns per kind', () => {
    expect(workloadPodPattern('StatefulSet', 'db')).toBe('db-[0-9]+');
    expect(workloadPodPattern('DaemonSet', 'agent')).toBe('agent-[^-]+');
    expect(workloadPodPattern('CronJob', 'nightly')).toBe('nightly-[0-9]+-[^-]+');
    expect(workloadPodPattern('Service', 'x')).toBeNull();
    expect(escapeRegex('a.b+c')).toBe('a\\.b\\+c');
    expect(nodeInstancePattern('n1', [])).toBe('(n1)(:[0-9]+)?');
  });
});

describe('parseRange', () => {
  const body = {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [
        { metric: { container: 'app' }, values: [[1000, '0.5'], [1060, '0.75'], [1120, 'NaN'], [1180, '1']] },
        { metric: { container: 'side' }, values: [[1000, 'NaN']] },
        { metric: {}, values: [[1000, '2']] },
      ],
    },
  };

  test('reads series, turns NaN into a gap, and drops a series with no number', () => {
    const series = parseRange(body, { name: 'Container', by: 'container', query: 'q' });
    expect(series.map((s) => s.name)).toEqual(['app', 'Container']);
    expect(series[0]!.points).toEqual([[1000, 0.5], [1060, 0.75], [1120, null], [1180, 1]]);
  });

  test('anything else is no series', () => {
    expect(parseRange(null, { name: 'x', query: 'q' })).toEqual([]);
    expect(parseRange({ status: 'success', data: { resultType: 'vector', result: [] } }, { name: 'x', query: 'q' })).toEqual([]);
    expect(parseRange({ status: 'error', error: 'bad' }, { name: 'x', query: 'q' })).toEqual([]);
  });

  test('a single unnamed series takes the query name', () => {
    const series = parseRange({ data: { resultType: 'matrix', result: [{ metric: {}, values: [[1, '1']] }] } }, { name: 'Total', query: 'q' });
    expect(series[0]!.name).toBe('Total');
  });
});

describe('limitSeries', () => {
  const line = (name: string, peak: number): Series => ({ name, points: [[0, 0], [60, peak]] });

  test('keeps the biggest few and counts the rest', () => {
    const { series, hidden } = limitSeries([line('a', 1), line('b', 5), line('c', 3), line('d', 9), line('e', 2), line('f', 4)]);
    expect(series.map((s) => s.name)).toEqual(['d', 'b', 'f', 'c']);
    expect(hidden).toBe(2);
    expect(limitSeries([line('a', 1)])).toEqual({ series: [line('a', 1)], hidden: 0 });
  });
});

describe('drawing', () => {
  test('niceMax rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceMax(0.37)).toBe(0.5);
    expect(niceMax(1.2)).toBe(2);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(1536)).toBe(2000);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
  });

  test('byte charts round in steps of 1024', () => {
    expect(niceMaxFor('bytes', 6.69 * 1024 ** 3)).toBe(10 * 1024 ** 3);
    expect(niceMaxFor('bytes', 3.1 * 1024 ** 2)).toBe(5 * 1024 ** 2);
    expect(niceMaxFor('bytesPerSecond', 600)).toBe(1000);
    expect(niceMaxFor('cores', 0.37)).toBe(0.5);
  });

  test('bounds cover the time range and leave room above the peak; percent always reaches 100', () => {
    const lines: Series[] = [{ name: 'a', points: [[100, 0.2], [160, null], [220, 0.4]] }];
    expect(boundsOf(lines, 'cores')).toEqual({ start: 100, end: 220, max: 0.5 });
    expect(boundsOf(lines, 'percent').max).toBe(10);
    expect(boundsOf([{ name: 'x', points: [[0, 40], [60, 77]] }], 'percent').max).toBe(100);
    expect(boundsOf([{ name: 'x', points: [[0, 1.7], [60, 2.6]] }], 'percent').max).toBe(10);
    expect(boundsOf([{ name: 'x', points: [[0, 30], [60, 45]] }], 'percent').max).toBe(50);
    expect(boundsOf([], 'cores')).toEqual({ start: 0, end: 1, max: 1 });
    expect(boundsOf([{ name: 'x', points: [[5, 1]] }], 'cores').end).toBe(6);
  });

  test('a gap starts a new piece of the line', () => {
    const x = (t: number): number => t;
    const y = (v: number): number => 100 - v;
    expect(linePath([[0, 10], [10, 20], [20, null], [30, 5], [40, 6]], x, y)).toBe('M0.0 90.0L10.0 80.0M30.0 95.0L40.0 94.0');
    expect(linePath([[0, null]], x, y)).toBe('');
  });

  test('the area closes down to the floor, once per piece', () => {
    const area = areaPath([[0, 10], [10, 20], [20, null], [30, 5]], (t) => t, (v) => 100 - v, 100);
    expect(area).toBe('M0.0 100.0L0.0 90.0L10.0 80.0L10.0 100.0ZM30.0 100.0L30.0 95.0L30.0 100.0Z');
    expect(areaPath([], (t) => t, (v) => v, 0)).toBe('');
  });

  test('values read in their unit', () => {
    expect(valueText('cores', 0.0124, true)).toBe('12m');
    expect(valueText('cores', 0.5)).toBe('0.5');
    expect(valueText('bytes', 3 * 1024 ** 3)).toBe('3 GiB');
    expect(valueText('bytesPerSecond', 2048)).toBe('2 KiB/s');
    expect(valueText('percent', 23.4)).toBe('23%');
  });

  test('nearestIndex finds the closest point in time', () => {
    const points: Series['points'] = [[0, 1], [60, 2], [120, 3]];
    expect(nearestIndex(points, 70)).toBe(1);
    expect(nearestIndex(points, 500)).toBe(2);
    expect(nearestIndex([], 1)).toBe(-1);
  });
});

describe('chartTargetOf', () => {
  test('pods, workloads and nodes have charts; other kinds do not', () => {
    expect(chartTargetOf({ kind: 'Pod', metadata: { name: 'p', namespace: 'gm' } })).toEqual({ scope: 'pod', namespace: 'gm', name: 'p' });
    expect(chartTargetOf({ kind: 'StatefulSet', metadata: { name: 'db', namespace: 'gm' } })).toEqual({ scope: 'workload', kind: 'StatefulSet', namespace: 'gm', name: 'db' });
    expect(chartTargetOf({ kind: 'Node', metadata: { name: 'n1' }, status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }, { type: 'Hostname', address: 'n1' }] } })).toEqual({ scope: 'node', name: 'n1', addresses: ['10.0.0.1', 'n1'] });
    expect(chartTargetOf({ kind: 'Service', metadata: { name: 's', namespace: 'gm' } })).toBeNull();
    expect(chartTargetOf({ kind: 'Pod', metadata: { name: 'p' } })).toBeNull();
    expect(chartTargetOf({ kind: 'Pod', metadata: {} })).toBeNull();
  });
});
