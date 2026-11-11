import { useEffect, useRef, useState } from 'preact/hooks';
import type { Obj } from '../shared/types.ts';
import { call } from './host.ts';
import { subscribeLogs } from './watches.ts';

/** One pod whose container logs are followed. `containers` is the pod's container names. */
export interface LogTarget {
  pod: string;
  containers: string[];
}

export interface LogLine {
  /** Increases across the merged view, for a stable key. */
  n: number;
  pod: string;
  text: string;
}

/** Lines kept in the frame. The rest is dropped from the front, oldest first. */
export const LOG_CAP = 5000;
export const WORKLOAD_PODS_MAX = 10;

export interface LogOptions {
  context: string;
  dir: string | null;
  namespace: string;
  /** The chosen container, or null for each pod's first container. */
  container: string | null;
  previous: boolean;
  timestamps: boolean;
}

export interface LogsState {
  lines: LogLine[];
  state: 'idle' | 'connecting' | 'live' | 'ended' | 'error';
  error: string | null;
  clear: () => void;
}

const containerFor = (target: LogTarget, chosen: string | null): string | undefined => (chosen && target.containers.includes(chosen) ? chosen : target.containers[0]);

/** Follows one stream per pod, merges the lines in arrival order and keeps the last LOG_CAP of them. */
export const useLogs = (targets: LogTarget[] | null, options: LogOptions): LogsState => {
  const [tick, setTick] = useState(0);
  const lines = useRef<LogLine[]>([]);
  const next = useRef(0);
  const phase = useRef<LogsState['state']>('idle');
  const errorRef = useRef<string | null>(null);
  const key = targets ? `${options.context}|${options.namespace}|${options.container ?? ''}|${options.previous}|${options.timestamps}|${targets.map((target) => target.pod).join(',')}` : '';

  const clear = (): void => {
    lines.current = [];
    next.current = 0;
    setTick((value) => value + 1);
  };

  useEffect(() => {
    lines.current = [];
    next.current = 0;
    errorRef.current = null;
    phase.current = targets && targets.length > 0 ? 'connecting' : 'idle';
    setTick((value) => value + 1);
    if (!targets || targets.length === 0) return;
    let cancelled = false;
    const stops = new Map<string, () => void>();
    const streamIds = new Set<string>();
    const active = new Set<string>();
    const failed = new Set<string>();

    const bump = (): void => {
      if (!cancelled) setTick((value) => value + 1);
    };

    const settle = (): void => {
      if (active.size > 0) phase.current = 'live';
      else if (failed.size > 0) phase.current = 'error';
      else if (phase.current !== 'idle') phase.current = 'ended';
      bump();
    };

    const open = async (target: LogTarget): Promise<void> => {
      const container = containerFor(target, options.container);
      const reply = await call('POST', '/logs', {
        context: options.context,
        dir: options.dir,
        namespace: options.namespace,
        pod: target.pod,
        container,
        previous: options.previous,
        timestamps: options.timestamps,
        tailLines: 500,
      });
      if (cancelled) return;
      if (!reply.ok) {
        failed.add(target.pod);
        errorRef.current = String(reply.error ?? 'Could not open the logs.');
        settle();
        return;
      }
      const streamId = String(reply.streamId);
      streamIds.add(streamId);
      active.add(streamId);
      stops.set(streamId, subscribeLogs(streamId, {
        onLines: (incoming) => {
          for (const text of incoming) {
            lines.current.push({ n: next.current++, pod: target.pod, text });
          }
          if (lines.current.length > LOG_CAP) lines.current = lines.current.slice(lines.current.length - LOG_CAP);
          bump();
        },
        onEnd: (state, code) => {
          active.delete(streamId);
          if (state === 'error') {
            failed.add(target.pod);
            errorRef.current = code ? `The log stream stopped (${code}).` : 'The log stream stopped.';
          }
          settle();
        },
        onUnknown: () => {
          active.delete(streamId);
          void open(target);
        },
      }));
      settle();
    };

    for (const target of targets.slice(0, WORKLOAD_PODS_MAX)) void open(target);
    phase.current = 'live';
    bump();

    return () => {
      cancelled = true;
      for (const stop of stops.values()) stop();
      for (const id of streamIds) void call('POST', '/logs/stop', { streamId: id });
    };
  }, [key]);

  return { lines: lines.current, state: phase.current, error: errorRef.current, clear };
};

/** The pods a workload runs, so its logs can be merged. One list call, no timer. */
export const podsFor = async (object: Obj, context: string, dir: string | null, namespace: string): Promise<LogTarget[]> => {
  const kind = String(object.kind ?? '');
  const containers = (spec: Obj): string[] => (Array.isArray(spec?.containers) ? (spec.containers as Obj[]).map((container) => String(container.name)) : []);
  if (kind === 'Pod') return [{ pod: String(object.metadata?.name ?? ''), containers: containers(object.spec) }];
  const selector = object.spec?.selector?.matchLabels as Record<string, string> | undefined;
  const fieldSelector = kind === 'Job' ? `job-name=${String(object.metadata?.name ?? '')}` : undefined;
  const labelSelector = selector ? Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(',') : undefined;
  if (!labelSelector && !fieldSelector) return [];
  const reply = await call('GET', '/list', { context, dir, kind: 'Pod', namespace: namespace || '_all', ...(labelSelector ? { labelSelector } : {}), ...(fieldSelector ? { fieldSelector } : {}) });
  if (!reply.ok) return [];
  const pods = (reply.items as Obj[]).filter((pod) => !pod.metadata?.deletionTimestamp);
  return pods.slice(0, WORKLOAD_PODS_MAX).map((pod) => ({ pod: String(pod.metadata?.name ?? ''), containers: containers(pod.spec) }));
};
