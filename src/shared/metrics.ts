// metrics-server numbers. The service compacts the cluster's answers to these shapes; the panel keeps them in maps.
import { parseQuantity } from './format.ts';
import type { Obj } from './types.ts';

/** CPU in cores, memory in bytes. */
export interface Usage {
  cpu: number | null;
  memory: number | null;
}

export interface NodeUsage extends Usage {
  diskUsed: number | null;
  diskCapacity: number | null;
}

/**
 * ok: numbers are here. missing: no metrics-server in the cluster. unavailable: it is installed but did not answer.
 * forbidden: the account may not read metrics. loading: the panel has not heard back yet.
 */
export type MetricsStatus = 'loading' | 'ok' | 'missing' | 'unavailable' | 'forbidden';

export interface UsageSet {
  status: MetricsStatus;
  message?: string;
  /** When the cluster measured it (epoch ms), or null. */
  at: number | null;
  nodes: Map<string, NodeUsage>;
  pods: Map<string, Usage>;
  /** The node disk numbers could not be read (kubelet access), though CPU and memory could. */
  diskStatus?: 'ok' | 'forbidden' | 'unavailable';
}

export const podUsageKey = (namespace: string, name: string): string => `${namespace}/${name}`;

export const emptyUsage = (status: MetricsStatus = 'loading'): UsageSet => ({ status, at: null, nodes: new Map(), pods: new Map() });

const num = (value: unknown): number | null => parseQuantity(value);

const timeOf = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

export interface NodeMetric {
  name: string;
  cpu: number | null;
  memory: number | null;
  at: number | null;
}

export interface PodMetric {
  namespace: string;
  name: string;
  cpu: number | null;
  memory: number | null;
  at: number | null;
}

/** `NodeMetricsList` to one row per node. */
export const compactNodeMetrics = (list: Obj): NodeMetric[] =>
  ((list.items ?? []) as Obj[])
    .map((item) => ({
      name: String(item.metadata?.name ?? ''),
      cpu: num(item.usage?.cpu),
      memory: num(item.usage?.memory),
      at: timeOf(item.timestamp),
    }))
    .filter((row) => row.name);

const sum = (values: Array<number | null>): number | null => {
  let total = 0;
  let any = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    any = true;
  }
  return any ? total : null;
};

/** `PodMetricsList` to one row per pod: the containers added together. */
export const compactPodMetrics = (list: Obj): PodMetric[] =>
  ((list.items ?? []) as Obj[])
    .map((item) => {
      const containers = (Array.isArray(item.containers) ? item.containers : []) as Obj[];
      return {
        namespace: String(item.metadata?.namespace ?? ''),
        name: String(item.metadata?.name ?? ''),
        cpu: sum(containers.map((c) => num(c.usage?.cpu))),
        memory: sum(containers.map((c) => num(c.usage?.memory))),
        at: timeOf(item.timestamp),
      };
    })
    .filter((row) => row.name);

/** The root file system numbers from a kubelet `stats/summary`. */
export const kubeletDisk = (summary: Obj): { used: number; capacity: number } | null => {
  const fs = summary.node?.fs;
  const used = typeof fs?.usedBytes === 'number' ? fs.usedBytes : null;
  const capacity = typeof fs?.capacityBytes === 'number' ? fs.capacityBytes : null;
  return used !== null && capacity !== null && capacity > 0 ? { used, capacity } : null;
};

/** The service's `GET /metrics` answer as maps. */
export const usageFromReply = (reply: Obj): UsageSet => {
  const set = emptyUsage((reply.status as MetricsStatus) ?? 'unavailable');
  if (typeof reply.message === 'string') set.message = reply.message;
  set.at = typeof reply.at === 'number' ? reply.at : null;
  if (reply.diskStatus === 'ok' || reply.diskStatus === 'forbidden' || reply.diskStatus === 'unavailable') set.diskStatus = reply.diskStatus;
  for (const row of (Array.isArray(reply.nodes) ? reply.nodes : []) as Obj[]) {
    set.nodes.set(String(row.name), { cpu: row.cpu ?? null, memory: row.memory ?? null, diskUsed: row.diskUsed ?? null, diskCapacity: row.diskCapacity ?? null });
  }
  for (const row of (Array.isArray(reply.pods) ? reply.pods : []) as Obj[]) {
    set.pods.set(podUsageKey(String(row.namespace), String(row.name)), { cpu: row.cpu ?? null, memory: row.memory ?? null });
  }
  return set;
};

/** What the user reads when there are no numbers. Never an error: the rest of the view still works. */
export const usageNote = (set: UsageSet): string => {
  switch (set.status) {
    case 'missing':
      return 'Install metrics-server for usage';
    case 'unavailable':
      return 'metrics-server is installed but not answering yet';
    case 'forbidden':
      return 'Your account may not read usage';
    default:
      return '';
  }
};
