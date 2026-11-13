import { useEffect, useRef, useState } from 'preact/hooks';
import { emptyUsage, usageFromReply, type UsageSet } from '../shared/metrics.ts';
import { call } from './host.ts';
import { useRetryOnSignIn } from './signin.ts';
import { onLeaseTick } from './watches.ts';

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

/** A lease tick reads usage again only when the numbers are older than this, so a tick right after a read does nothing. */
const STALE_MS = 20_000;

/**
 * Current usage from metrics-server. It cannot be watched, so this reads when the view opens, on every lease tick
 * (the panel's one timer, 30 s, only while visible) when the numbers are old, and when the user presses Refresh.
 */
export const useUsage = (spec: UsageSpec): UsageView => {
  const [usage, setUsage] = useState<UsageSet>(() => emptyUsage('loading'));
  const [refreshing, setRefreshing] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
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
      setAuthFailed(!reply.ok && reply.code === 'AUTH_EXPIRED');
      if (reply.ok) setUsage(usageFromReply(reply as Record<string, unknown>));
      else setUsage({ ...emptyUsage('unavailable'), message: String(reply.error ?? 'Usage could not be read.') });
    };
    readRef.current = () => void read();
    const stopTick = onLeaseTick(() => {
      if (document.visibilityState === 'visible' && Date.now() - readAt > STALE_MS) void read();
    });
    void read();
    return () => {
      cancelled = true;
      stopTick();
    };
  }, [key]);

  useRetryOnSignIn(spec.context, authFailed && spec.enabled, () => readRef.current());
  return { usage, refreshing, refresh: () => readRef.current() };
};
