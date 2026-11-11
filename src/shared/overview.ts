// The numbers behind the Cluster and Workloads overviews. Pure, so they run in tests.
import { parseQuantity } from './format.ts';
import { eventTime, podStatus, timeOf, viewFor, type StatusInfo, type Tone } from './kinds.ts';
import type { NodeUsage } from './metrics.ts';
import type { Obj } from './types.ts';

const arr = (value: unknown): Obj[] => (Array.isArray(value) ? (value as Obj[]) : []);
const qty = (value: unknown): number => parseQuantity(value) ?? 0;

export interface Requests {
  cpuRequests: number;
  cpuLimits: number;
  memoryRequests: number;
  memoryLimits: number;
}

const resourcesOf = (container: Obj): { cpu: number; memory: number; cpuLimit: number; memoryLimit: number } => ({
  cpu: qty(container.resources?.requests?.cpu),
  memory: qty(container.resources?.requests?.memory),
  cpuLimit: qty(container.resources?.limits?.cpu),
  memoryLimit: qty(container.resources?.limits?.memory),
});

/**
 * What the scheduler counts for a pod: the containers added together, or the largest init container when that is more
 * (init containers run one at a time; a sidecar init container keeps running and is added to everything after it).
 */
export const podRequests = (pod: Obj): Requests => {
  const spec = pod.spec ?? {};
  const totals = { cpu: 0, memory: 0, cpuLimit: 0, memoryLimit: 0 };
  const add = (into: typeof totals, from: ReturnType<typeof resourcesOf>): void => {
    into.cpu += from.cpu;
    into.memory += from.memory;
    into.cpuLimit += from.cpuLimit;
    into.memoryLimit += from.memoryLimit;
  };
  for (const container of arr(spec.containers)) add(totals, resourcesOf(container));
  const sidecars = { cpu: 0, memory: 0, cpuLimit: 0, memoryLimit: 0 };
  const peak = { ...totals };
  for (const container of arr(spec.initContainers)) {
    const own = resourcesOf(container);
    if (container.restartPolicy === 'Always') {
      add(sidecars, own);
      add(totals, own);
      for (const key of Object.keys(peak) as Array<keyof typeof peak>) peak[key] = Math.max(peak[key], sidecars[key]);
    } else {
      for (const key of Object.keys(peak) as Array<keyof typeof peak>) peak[key] = Math.max(peak[key], own[key] + sidecars[key]);
    }
  }
  const final = { cpu: Math.max(totals.cpu, peak.cpu), memory: Math.max(totals.memory, peak.memory), cpuLimit: Math.max(totals.cpuLimit, peak.cpuLimit), memoryLimit: Math.max(totals.memoryLimit, peak.memoryLimit) };
  const overhead = spec.overhead ?? {};
  return {
    cpuRequests: final.cpu + qty(overhead.cpu),
    cpuLimits: final.cpuLimit + qty(overhead.cpu),
    memoryRequests: final.memory + qty(overhead.memory),
    memoryLimits: final.memoryLimit + qty(overhead.memory),
  };
};

/** A pod that holds room on a node: scheduled and not finished. */
export const holdsRoom = (pod: Obj): boolean => Boolean(pod.spec?.nodeName) && pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed';

export interface Resource {
  allocatable: number;
  capacity: number;
  requests: number;
  limits: number;
  /** Null until metrics-server answered. */
  usage: number | null;
}

export interface ClusterTotals {
  nodes: { total: number; ready: number; notReady: number; cordoned: number };
  cpu: Resource;
  memory: Resource;
  pods: { allocatable: number; capacity: number; scheduled: number; running: number; pending: number; failed: number };
}

const nodeReady = (node: Obj): boolean => arr(node.status?.conditions).some((c) => c.type === 'Ready' && c.status === 'True');

/** Capacity, requests and usage for the whole cluster. `usage` is metrics-server's node usage, when there is any. */
export const clusterTotals = (nodes: Obj[], pods: Obj[], usage: Map<string, NodeUsage> | null): ClusterTotals => {
  const totals: ClusterTotals = {
    nodes: { total: nodes.length, ready: 0, notReady: 0, cordoned: 0 },
    cpu: { allocatable: 0, capacity: 0, requests: 0, limits: 0, usage: null },
    memory: { allocatable: 0, capacity: 0, requests: 0, limits: 0, usage: null },
    pods: { allocatable: 0, capacity: 0, scheduled: 0, running: 0, pending: 0, failed: 0 },
  };
  let cpuUsage = 0;
  let memoryUsage = 0;
  let measured = 0;
  for (const node of nodes) {
    if (nodeReady(node)) totals.nodes.ready += 1;
    else totals.nodes.notReady += 1;
    if (node.spec?.unschedulable) totals.nodes.cordoned += 1;
    totals.cpu.allocatable += qty(node.status?.allocatable?.cpu);
    totals.cpu.capacity += qty(node.status?.capacity?.cpu);
    totals.memory.allocatable += qty(node.status?.allocatable?.memory);
    totals.memory.capacity += qty(node.status?.capacity?.memory);
    totals.pods.allocatable += qty(node.status?.allocatable?.pods);
    totals.pods.capacity += qty(node.status?.capacity?.pods);
    const used = usage?.get(String(node.metadata?.name ?? ''));
    if (used && (used.cpu !== null || used.memory !== null)) {
      cpuUsage += used.cpu ?? 0;
      memoryUsage += used.memory ?? 0;
      measured += 1;
    }
  }
  if (measured > 0) {
    totals.cpu.usage = cpuUsage;
    totals.memory.usage = memoryUsage;
  }
  for (const pod of pods) {
    const phase = String(pod.status?.phase ?? '');
    if (phase === 'Failed') totals.pods.failed += 1;
    if (phase === 'Pending') totals.pods.pending += 1;
    if (!holdsRoom(pod)) continue;
    totals.pods.scheduled += 1;
    if (phase === 'Running') totals.pods.running += 1;
    const room = podRequests(pod);
    totals.cpu.requests += room.cpuRequests;
    totals.cpu.limits += room.cpuLimits;
    totals.memory.requests += room.memoryRequests;
    totals.memory.limits += room.memoryLimits;
  }
  return totals;
};

/** 0 to 1 and beyond (a cluster can request more than it has). Null when there is nothing to compare with. */
export const fractionOf = (value: number | null, of: number): number | null => (value === null || !(of > 0) ? null : value / of);

export type BarTone = 'primary' | 'warning' | 'error';

export const barTone = (fraction: number | null): BarTone => (fraction !== null && fraction >= 0.9 ? 'error' : fraction !== null && fraction >= 0.75 ? 'warning' : 'primary');

// ----- Workloads

export interface BreakdownPart {
  tone: Tone;
  text: string;
  count: number;
}

export interface WorkloadSummary {
  total: number;
  parts: BreakdownPart[];
}

const WORDS: Record<Tone, string> = { success: 'healthy', info: 'in progress', warning: 'needs attention', error: 'failing', muted: 'idle' };
const POD_WORDS: Record<Tone, string> = { success: 'running', info: 'pending', warning: 'not ready', error: 'failed', muted: 'completed' };
const ORDER: Tone[] = ['success', 'info', 'warning', 'error', 'muted'];

const replicaSetStatus = (rs: Obj): StatusInfo => {
  const desired = typeof rs.spec?.replicas === 'number' ? rs.spec.replicas : 1;
  const ready = typeof rs.status?.readyReplicas === 'number' ? rs.status.readyReplicas : 0;
  if (desired === 0) return { label: 'Scaled to 0', tone: 'muted' };
  if (ready < desired) return { label: 'Updating', tone: ready === 0 ? 'error' : 'info' };
  return { label: 'Ready', tone: 'success' };
};

/** Counts of a kind's objects by how healthy they look, in the order the stat card lists them. */
export const summarize = (kind: string, objects: Obj[]): WorkloadSummary => {
  const counts = new Map<Tone, number>();
  const view = viewFor({ kind, group: kind === 'Pod' ? '' : kind === 'Job' || kind === 'CronJob' ? 'batch' : 'apps', namespaced: true });
  const statusOf = kind === 'Pod' ? podStatus : kind === 'ReplicaSet' ? replicaSetStatus : view.status;
  for (const object of objects) {
    const tone = statusOf ? statusOf(object).tone : 'success';
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  const words = kind === 'Pod' ? POD_WORDS : WORDS;
  return {
    total: objects.length,
    parts: ORDER.filter((tone) => (counts.get(tone) ?? 0) > 0).map((tone) => ({ tone, count: counts.get(tone) ?? 0, text: `${counts.get(tone)} ${words[tone]}` })),
  };
};

// ----- Warning events

export interface WarningEvent {
  key: string;
  reason: string;
  message: string;
  object: string;
  namespace: string;
  count: number;
  at: number | null;
}

/** The newest Warning events first. Events of other types are ignored, so a list that was not filtered by the service still works. */
export const warningEvents = (events: Obj[], limit: number): WarningEvent[] =>
  events
    .filter((event) => event.type === 'Warning')
    .map((event) => {
      const ref = event.involvedObject ?? event.regarding;
      return {
        key: `${String(event.metadata?.namespace ?? '')}/${String(event.metadata?.name ?? '')}`,
        reason: String(event.reason ?? ''),
        message: String(event.message ?? event.note ?? ''),
        object: ref ? `${String(ref.kind ?? '')}/${String(ref.name ?? '')}` : '',
        namespace: String(event.metadata?.namespace ?? ''),
        count: typeof event.count === 'number' ? event.count : typeof event.series?.count === 'number' ? event.series.count : 1,
        at: eventTime(event) ?? timeOf(event.metadata?.creationTimestamp),
      };
    })
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, limit);
