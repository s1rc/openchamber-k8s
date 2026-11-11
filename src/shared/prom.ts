// Prometheus: which Service is the server, the fixed queries behind the charts, and the chart geometry.
// Pure, so the queries and the drawing maths are tested without a cluster.
import { bytesText, coresText, cpuText, rateText } from './format.ts';
import type { Obj } from './types.ts';

export interface PromService {
  namespace: string;
  name: string;
  /** A port number or a port name, as the service proxy path accepts it. */
  port: string;
}

// ----- Finding the server

/** Companions of a Prometheus install that look like it by name but answer no queries. */
const NOT_A_SERVER = /alertmanager|exporter|kube-state-metrics|pushgateway|operator|adapter|blackbox|grafana|thanos|promtail/i;
const SERVER_LABELS = new Set(['prometheus', 'kube-prometheus-stack-prometheus']);
const WEB_PORTS = new Set(['web', 'http', 'http-web', 'web-http', 'prometheus', 'http-prometheus']);
const HOME_NAMESPACES = new Set(['monitoring', 'prometheus', 'observability', 'kube-prometheus-stack', 'kube-system']);

const nameLooksLikeServer = (name: string): boolean => name === 'prometheus' || name === 'prometheus-operated' || name.startsWith('prometheus-') || /-prometheus$/.test(name);

const pickPort = (service: Obj): string | null => {
  const ports = ((service.spec?.ports ?? []) as Obj[]).filter((port) => !port.protocol || port.protocol === 'TCP');
  const chosen = ports.find((port) => WEB_PORTS.has(String(port.name ?? ''))) ?? ports.find((port) => port.port === 9090) ?? ports.find((port) => port.port === 80) ?? ports[0];
  return chosen && chosen.port !== undefined ? String(chosen.port) : null;
};

/** Services that look like a Prometheus server, best first. Matches the plan's rules: the labels, or the names. */
export const promCandidates = (services: Obj[]): PromService[] => {
  const scored: Array<{ score: number; service: PromService }> = [];
  for (const service of services) {
    const name = String(service.metadata?.name ?? '');
    const namespace = String(service.metadata?.namespace ?? '');
    if (!name || !namespace || NOT_A_SERVER.test(name)) continue;
    const label = String(service.metadata?.labels?.['app.kubernetes.io/name'] ?? '');
    const labelled = SERVER_LABELS.has(label);
    if (!labelled && !nameLooksLikeServer(name)) continue;
    // A name like prometheus-foo whose own label says it is something else is a companion, not the server.
    if (label && !labelled) continue;
    const port = pickPort(service);
    if (!port) continue;
    let score = labelled ? 4 : 0;
    if (name === 'prometheus-server' || name === 'kube-prometheus-stack-prometheus' || name === 'prometheus-operated' || name === 'prometheus') score += 3;
    if (service.metadata?.labels?.['app.kubernetes.io/component'] === 'server') score += 1;
    if (HOME_NAMESPACES.has(namespace)) score += 1;
    if (service.spec?.clusterIP === 'None') score -= 1;
    scored.push({ score, service: { namespace, name, port } });
  }
  return scored
    .sort((a, b) => b.score - a.score || `${a.service.namespace}/${a.service.name}`.localeCompare(`${b.service.namespace}/${b.service.name}`))
    .map((entry) => entry.service);
};

const DNS = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const PORT = /^([0-9]{1,5}|[a-z0-9]([-a-z0-9]*[a-z0-9])?)$/;

/** Checks a Service the user typed in. Returns it cleaned, or the reason it is not usable. */
export const parsePromService = (input: { namespace?: unknown; service?: unknown; port?: unknown }): PromService | string => {
  const namespace = String(input.namespace ?? '').trim();
  const name = String(input.service ?? '').trim();
  const port = String(input.port ?? '').trim();
  if (!namespace || !DNS.test(namespace) || namespace.length > 63) return 'Enter the namespace of the Prometheus service.';
  if (!name || !DNS.test(name) || name.length > 253) return 'Enter the name of the Prometheus service.';
  if (!PORT.test(port)) return 'Enter a port number or a port name.';
  return { namespace, name, port };
};

/** The API server path that reaches a service through its proxy. */
export const proxyBase = (service: PromService): string =>
  `/api/v1/namespaces/${encodeURIComponent(service.namespace)}/services/${encodeURIComponent(service.name)}:${encodeURIComponent(service.port)}/proxy`;

// ----- Queries

export type ChartUnit = 'cores' | 'bytes' | 'bytesPerSecond' | 'percent';

export interface ChartQuery {
  /** The series name when the query returns one series; otherwise the label named by `by`. */
  name: string;
  by?: string;
  query: string;
}

export interface ChartSpec {
  id: 'cpu' | 'memory' | 'network' | 'filesystem';
  title: string;
  unit: ChartUnit;
  queries: ChartQuery[];
  /** Asked only when `queries` return nothing: some runtimes do not report what the chart is about. `note` says what is shown instead. */
  fallback?: { note: string; queries: ChartQuery[] };
}

export type ChartScope =
  | { scope: 'pod'; namespace: string; name: string }
  | { scope: 'workload'; kind: string; namespace: string; name: string }
  | { scope: 'node'; name: string; addresses: string[] };

export const SERIES_SHOWN = 4;
/** The rate window. Wider than the scrape interval so a 1 minute scrape still has two samples. */
const RATE = '5m';

/** A value inside a PromQL double-quoted string. */
export const promString = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Kubernetes names the pods of a workload after it, so the pod names tell which pods belong to it. */
export const workloadPodPattern = (kind: string, name: string): string | null => {
  const base = escapeRegex(name);
  switch (kind) {
    case 'Deployment':
      return `${base}-[^-]+-[^-]+`;
    case 'StatefulSet':
      return `${base}-[0-9]+`;
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
      return `${base}-[^-]+`;
    case 'CronJob':
      return `${base}-[0-9]+-[^-]+`;
    default:
      return null;
  }
};

export const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job']);

const NAME = /^[A-Za-z0-9._:-]{1,253}$/;

/** What node_exporter calls a node: its address with a port, or its name. */
export const nodeInstancePattern = (name: string, addresses: string[]): string => {
  const names = [name, ...addresses].filter(Boolean).map(escapeRegex);
  return `(${names.join('|')})(:[0-9]+)?`;
};

const podSelector = (namespace: string, pod: string, regex: boolean): string => `namespace="${promString(namespace)}",pod${regex ? '=~' : '='}"${promString(pod)}",container!="",container!="POD"`;

/** The four charts for one pod, workload or node. Every value is escaped; nothing the user typed becomes a query itself. */
export const chartSpecs = (target: ChartScope): ChartSpec[] => {
  if (!NAME.test(target.name)) throw new Error('Not a valid name.');
  if ('namespace' in target && !NAME.test(target.namespace)) throw new Error('Not a valid namespace.');
  if (target.scope === 'pod' || target.scope === 'workload') {
    const regex = target.scope === 'workload';
    let pod = target.name;
    if (target.scope === 'workload') {
      const pattern = workloadPodPattern(target.kind, target.name);
      if (!pattern) throw new Error(`No charts for ${target.kind}.`);
      pod = pattern;
    }
    const selector = podSelector(target.namespace, pod, regex);
    const net = `namespace="${promString(target.namespace)}",pod${regex ? '=~' : '='}"${promString(pod)}"`;
    const by = regex ? '' : ' by (container)';
    const series = (metric: string): ChartQuery => ({ name: regex ? 'Total' : 'Container', by: regex ? undefined : 'container', query: `sum${by} (${metric})` });
    return [
      { id: 'cpu', title: 'CPU', unit: 'cores', queries: [series(`rate(container_cpu_usage_seconds_total{${selector}}[${RATE}])`)] },
      { id: 'memory', title: 'Memory', unit: 'bytes', queries: [series(`container_memory_working_set_bytes{${selector}}`)] },
      {
        id: 'network',
        title: 'Network',
        unit: 'bytesPerSecond',
        queries: [
          { name: 'Received', query: `sum(rate(container_network_receive_bytes_total{${net}}[${RATE}]))` },
          { name: 'Sent', query: `sum(rate(container_network_transmit_bytes_total{${net}}[${RATE}]))` },
        ],
      },
      {
        id: 'filesystem',
        title: 'Filesystem',
        unit: 'bytes',
        queries: [series(`container_fs_usage_bytes{${selector}}`)],
        fallback: { note: 'This cluster does not report disk use per container. Showing the size of the log files instead.', queries: [series(`kubelet_container_log_filesystem_used_bytes{${selector}}`)] },
      },
    ];
  }
  const instance = promString(nodeInstancePattern(target.name, target.addresses.filter((address) => NAME.test(address))));
  const pick = `instance=~"${instance}"`;
  const device = 'device!~"lo|veth.*|docker.*|cali.*|flannel.*|cni.*|eni.*|cbr.*"';
  const disk = `${pick},mountpoint="/",fstype!~"tmpfs|rootfs"`;
  return [
    { id: 'cpu', title: 'CPU', unit: 'percent', queries: [{ name: 'Used', query: `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle",${pick}}[${RATE}])))` }] },
    { id: 'memory', title: 'Memory', unit: 'bytes', queries: [{ name: 'Used', query: `sum(node_memory_MemTotal_bytes{${pick}}) - sum(node_memory_MemAvailable_bytes{${pick}})` }] },
    {
      id: 'network',
      title: 'Network',
      unit: 'bytesPerSecond',
      queries: [
        { name: 'Received', query: `sum(rate(node_network_receive_bytes_total{${pick},${device}}[${RATE}]))` },
        { name: 'Sent', query: `sum(rate(node_network_transmit_bytes_total{${pick},${device}}[${RATE}]))` },
      ],
    },
    { id: 'filesystem', title: 'Filesystem', unit: 'bytes', queries: [{ name: 'Used', query: `sum(node_filesystem_size_bytes{${disk}}) - sum(node_filesystem_avail_bytes{${disk}})` }] },
  ];
};

// ----- Reading answers

/** One line: `[seconds, value]`; a gap is a null value. */
export type Point = [number, number | null];

export interface Series {
  name: string;
  points: Point[];
}

/** A `query_range` answer as series. A series with no number in it is dropped. */
export const parseRange = (body: unknown, query: ChartQuery): Series[] => {
  const data = (body as Obj | null)?.data;
  if (!data || data.resultType !== 'matrix' || !Array.isArray(data.result)) return [];
  const out: Series[] = [];
  for (const entry of data.result as Obj[]) {
    const points: Point[] = [];
    let any = false;
    for (const pair of (Array.isArray(entry.values) ? entry.values : []) as unknown[][]) {
      const time = Number(pair[0]);
      const value = Number(pair[1]);
      if (!Number.isFinite(time)) continue;
      if (Number.isFinite(value)) {
        points.push([time, value]);
        any = true;
      } else points.push([time, null]);
    }
    if (!any) continue;
    const label = query.by ? String(entry.metric?.[query.by] ?? '') : '';
    out.push({ name: label || query.name, points });
  }
  return out;
};

const peak = (series: Series): number => series.points.reduce((max, [, value]) => (value !== null && value > max ? value : max), 0);

/** The series a chart draws: the biggest few, so the chart stays readable. `hidden` counts the rest. */
export const limitSeries = (series: Series[], limit = SERIES_SHOWN): { series: Series[]; hidden: number } => {
  if (series.length <= limit) return { series, hidden: 0 };
  const kept = [...series].sort((a, b) => peak(b) - peak(a)).slice(0, limit);
  return { series: kept, hidden: series.length - limit };
};

// ----- Drawing

/** A chart value with its unit. `precise` is for a readout (12m), the axis uses plain numbers (0.01). */
export const valueText = (unit: ChartUnit, value: number, precise = false): string => {
  switch (unit) {
    case 'cores':
      return precise ? cpuText(value) : coresText(value);
    case 'bytes':
      return bytesText(value);
    case 'bytesPerSecond':
      return rateText(value);
    case 'percent':
      return `${Math.round(value)}%`;
  }
};

/** A round number at or above `value`: 1, 2, 5 times a power of ten. */
export const niceMax = (value: number): number => {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const unit = value / power;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return step * power;
};

/** Byte charts round in steps of 1024 (so the top reads 8 GiB, not 9.31 GiB); the others in tens. */
export const niceMaxFor = (unit: ChartUnit, value: number): number => {
  if ((unit === 'bytes' || unit === 'bytesPerSecond') && value >= 1024) {
    const base = 1024 ** Math.floor(Math.log(value) / Math.log(1024));
    return niceMax(value / base) * base;
  }
  return niceMax(value);
};

export interface Bounds {
  start: number;
  end: number;
  max: number;
}

export const boundsOf = (series: Series[], unit: ChartUnit): Bounds => {
  let start = Infinity;
  let end = -Infinity;
  let max = 0;
  for (const line of series) {
    for (const [time, value] of line.points) {
      start = Math.min(start, time);
      end = Math.max(end, time);
      if (value !== null) max = Math.max(max, value);
    }
  }
  if (!Number.isFinite(start)) return { start: 0, end: 1, max: 1 };
  const to = end > start ? end : start + 1;
  // A percent chart stops at 100, but starts from what the data needs so a quiet node is not a flat line.
  if (unit === 'percent') return { start, end: to, max: Math.min(100, Math.max(10, niceMax(max * 1.1))) };
  return { start, end: to, max: niceMaxFor(unit, max * 1.05) };
};

/** An SVG path for one series. A gap in the data starts a new piece. */
export const linePath = (points: Point[], x: (time: number) => number, y: (value: number) => number): string => {
  let path = '';
  let open = false;
  for (const [time, value] of points) {
    if (value === null) {
      open = false;
      continue;
    }
    path += `${open ? 'L' : 'M'}${x(time).toFixed(1)} ${y(value).toFixed(1)}`;
    open = true;
  }
  return path;
};

/** The closed shape under a single series, for the area fill. Gaps close their own piece. */
export const areaPath = (points: Point[], x: (time: number) => number, y: (value: number) => number, floor: number): string => {
  let path = '';
  let run: Array<[number, number]> = [];
  const close = (): void => {
    if (run.length === 0) return;
    path += `M${run[0]![0].toFixed(1)} ${floor.toFixed(1)}`;
    for (const [px, py] of run) path += `L${px.toFixed(1)} ${py.toFixed(1)}`;
    path += `L${run[run.length - 1]![0].toFixed(1)} ${floor.toFixed(1)}Z`;
    run = [];
  };
  for (const [time, value] of points) {
    if (value === null) close();
    else run.push([x(time), y(value)]);
  }
  close();
  return path;
};

/** The index of the point nearest to a time, or -1 for no points. */
export const nearestIndex = (points: Point[], time: number): number => {
  let best = -1;
  let gap = Infinity;
  points.forEach(([at], index) => {
    const distance = Math.abs(at - time);
    if (distance < gap) {
      gap = distance;
      best = index;
    }
  });
  return best;
};

/** Where the charts for an object come from, or null for a kind that has none. */
export const chartTargetOf = (object: Obj): ChartScope | null => {
  const kind = String(object.kind ?? '');
  const name = String(object.metadata?.name ?? '');
  const namespace = String(object.metadata?.namespace ?? '');
  if (!name) return null;
  if (kind === 'Node') {
    const addresses = ((object.status?.addresses ?? []) as Obj[]).map((entry) => String(entry.address ?? '')).filter(Boolean);
    return { scope: 'node', name, addresses };
  }
  if (!namespace) return null;
  if (kind === 'Pod') return { scope: 'pod', namespace, name };
  if (WORKLOAD_KINDS.has(kind)) return { scope: 'workload', kind, namespace, name };
  return null;
};
