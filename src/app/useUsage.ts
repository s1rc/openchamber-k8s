import { useEffect, useRef, useState } from 'preact/hooks';
import { emptyUsage, usageFromReply, type UsageSet } from '../shared/metrics.ts';
import { call } from './host.ts';

export interface UsageSpec {
  context: string;
  dir: string | null;
  /** `_all` for every namespace (only pods are namespaced). */
  namespace: string;
  nodes: boolean;
  pods: boolean;
  /** Also read each node's root disk from its kubelet (slower: one call per node). */
  disk?: boolean;
  enabled: boolean;
}

export interface UsageView {
  usage: UsageSet;
  refreshing: boolean;
  refresh: () => void;
}

/** A page that has been hidden and shows again reads usage once more when its numbers are this old. */
const STALE_MS = 20_000;

/**
 * Current usage from metrics-server. It cannot be watched, so this reads when the view opens, when the panel becomes
 * visible again with old numbers, and when the user presses Refresh. There is no timer.
 */
export const useUsage = (spec: UsageSpec): UsageView => {
  const [usage, setUsage] = useState<UsageSet>(() => emptyUsage('loading'));
  const [refreshing, setRefreshing] = useState(false);
  const readRef = useRef<() => void>(() => undefined);
  const key = `${spec.enabled}|${spec.context}|${spec.namespace}|${spec.nodes}|${spec.pods}|${spec.disk ?? false}|${spec.dir ?? ''}`;

  useEffect(() => {
    setUsage(emptyUsage('loading'));
    setRefreshing(false);
    if (!spec.enabled) {
      readRef.current = () => undefined;
      return;
    }
    let cancelled = false;
    let latest = 0;
    let readAt = 0;
    const read = async (): Promise<void> => {
      const mine = ++latest;
      setRefreshing(true);
      const reply = await call('GET', '/metrics', {
        context: spec.context,
        dir: spec.dir,
        namespace: spec.namespace,
        nodes: spec.nodes ? '1' : undefined,
        pods: spec.pods ? '1' : undefined,
        disk: spec.disk ? '1' : undefined,
      });
      if (cancelled || mine !== latest) return;
      readAt = Date.now();
      setRefreshing(false);
      if (reply.ok) setUsage(usageFromReply(reply as Record<string, unknown>));
      else setUsage({ ...emptyUsage('unavailable'), message: String(reply.error ?? 'Usage could not be read.') });
    };
    readRef.current = () => void read();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && Date.now() - readAt > STALE_MS) void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    void read();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key]);

  return { usage, refreshing, refresh: () => readRef.current() };
};
