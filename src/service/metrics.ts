import { compactNodeMetrics, compactPodMetrics, kubeletDisk, type MetricsStatus } from '../shared/metrics.ts';
import type { Target } from '../shared/types.ts';
import { K8sError } from './errors.ts';
import { callJson } from './k8s.ts';
import { targetKey } from './proxy.ts';

// metrics-server (the metrics.k8s.io API) for current usage. It cannot be watched, so these are plain reads.
// A short cache keeps the rail and the page, and a quick click on Refresh, from asking the cluster twice.

const BASE = '/apis/metrics.k8s.io/v1beta1';
const CACHE_MS = 10_000;
const DISK_CACHE_MS = 120_000;
const DISK_PARALLEL = 6;

export interface MetricsAnswer {
  status: Exclude<MetricsStatus, 'loading'>;
  message?: string;
  at: number | null;
  nodes: Array<{ name: string; cpu: number | null; memory: number | null; diskUsed: number | null; diskCapacity: number | null }>;
  pods: Array<{ namespace: string; name: string; cpu: number | null; memory: number | null }>;
  diskStatus?: 'ok' | 'forbidden' | 'unavailable';
}

export interface MetricsWant {
  nodes: boolean;
  pods: boolean;
  disk: boolean;
  /** Null for every namespace. */
  namespace: string | null;
}

const cache = new Map<string, { at: number; value: unknown }>();

const cached = async <T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) for (const [old, entry] of cache) if (Date.now() - entry.at > ttl) cache.delete(old);
  return value;
};

/** Turns the failures that mean "no usage" into a status. Anything else (sign in, network) is a real error. */
export const statusFromError = (error: unknown): { status: 'missing' | 'unavailable' | 'forbidden'; message: string } | null => {
  if (!(error instanceof K8sError)) return null;
  if (error.code === 'NOT_FOUND') return { status: 'missing', message: 'This cluster has no metrics-server.' };
  if (error.code === 'FORBIDDEN') return { status: 'forbidden', message: error.message };
  // The API server answers 503 when the metrics APIService has no healthy pod behind it, or 500/502/504 while it starts.
  if (error.code === 'K8S_ERROR' && (error.status === 503 || error.status === 502 || error.status === 504 || error.status === 500)) {
    return { status: 'unavailable', message: error.message };
  }
  return null;
};

const readNodeDisk = async (target: Target, name: string): Promise<{ used: number; capacity: number } | 'forbidden' | null> => {
  try {
    const summary = await callJson(target, { path: `/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`, timeoutMs: 8000 });
    return kubeletDisk(summary);
  } catch (error) {
    if (error instanceof K8sError && error.code === 'FORBIDDEN') return 'forbidden';
    if (error instanceof K8sError && (error.code === 'AUTH_EXPIRED' || error.code === 'NO_KUBECTL')) throw error;
    return null;
  }
};

/** Root disk use per node, read from each kubelet through the API server. A node that does not answer is left out. */
const readDisks = async (target: Target, names: string[]): Promise<{ status: 'ok' | 'forbidden' | 'unavailable'; disks: Map<string, { used: number; capacity: number }> }> => {
  const disks = new Map<string, { used: number; capacity: number }>();
  let forbidden = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < names.length) {
      const name = names[next++]!;
      const found = await readNodeDisk(target, name);
      if (found === 'forbidden') forbidden = true;
      else if (found) disks.set(name, found);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DISK_PARALLEL, names.length) }, worker));
  return { status: disks.size > 0 ? 'ok' : forbidden ? 'forbidden' : 'unavailable', disks };
};

/** Usage for nodes and pods. A cluster without metrics-server is an answer (`missing`), not an error. */
export const readMetrics = async (target: Target, want: MetricsWant): Promise<MetricsAnswer> => {
  const key = targetKey(target);
  const answer: MetricsAnswer = { status: 'ok', at: null, nodes: [], pods: [] };
  try {
    if (want.nodes) {
      const nodes = await cached(`${key}|nodes`, CACHE_MS, async () => compactNodeMetrics(await callJson(target, { path: `${BASE}/nodes`, timeoutMs: 20_000 })));
      let disks: Map<string, { used: number; capacity: number }> = new Map();
      if (want.disk) {
        const read = await cached(`${key}|disk`, DISK_CACHE_MS, () => readDisks(target, nodes.map((node) => node.name)));
        answer.diskStatus = read.status;
        disks = read.disks;
      }
      answer.nodes = nodes.map((node) => ({ name: node.name, cpu: node.cpu, memory: node.memory, diskUsed: disks.get(node.name)?.used ?? null, diskCapacity: disks.get(node.name)?.capacity ?? null }));
      for (const node of nodes) if (node.at !== null) answer.at = Math.max(answer.at ?? 0, node.at);
    }
    if (want.pods) {
      const path = want.namespace ? `${BASE}/namespaces/${encodeURIComponent(want.namespace)}/pods` : `${BASE}/pods`;
      const pods = await cached(`${key}|${path}`, CACHE_MS, async () => compactPodMetrics(await callJson(target, { path, timeoutMs: 30_000 })));
      answer.pods = pods.map((pod) => ({ namespace: pod.namespace, name: pod.name, cpu: pod.cpu, memory: pod.memory }));
      for (const pod of pods) if (pod.at !== null) answer.at = Math.max(answer.at ?? 0, pod.at);
    }
    return answer;
  } catch (error) {
    const mapped = statusFromError(error);
    if (!mapped) throw error;
    return { status: mapped.status, message: mapped.message, at: null, nodes: [], pods: [] };
  }
};

export const clearMetricsCache = (): void => cache.clear();
