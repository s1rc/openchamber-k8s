import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { releaseObject, type HelmRelease } from '../../shared/helm.ts';
import type { Obj } from '../../shared/types.ts';
import type { ErrorInfo } from '../errors.tsx';
import { call } from '../host.ts';
import { objectKey } from '../apply-events.ts';
import type { WatchView } from '../useWatch.ts';

export interface HelmView extends WatchView {
  releases: HelmRelease[];
  refreshing: boolean;
}

/**
 * Helm releases, shaped like a live list so the resource table can show them. Helm has no watch, so this reads when the
 * view opens, on Refresh and after a change the panel made itself. It never polls.
 */
export const useHelmReleases = (spec: { context: string; namespace: string; dir: string | null }): HelmView => {
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; error: ErrorInfo | null; releases: HelmRelease[]; refreshing: boolean }>({ phase: 'loading', error: null, releases: [], refreshing: false });
  const readRef = useRef<() => void>(() => undefined);
  const key = `${spec.context}|${spec.namespace}|${spec.dir ?? ''}`;

  useEffect(() => {
    setState({ phase: 'loading', error: null, releases: [], refreshing: false });
    let cancelled = false;
    let latest = 0;
    const read = (): void => {
      const mine = ++latest;
      setState((prev) => ({ ...prev, refreshing: true }));
      void call('GET', '/helm/releases', { context: spec.context, dir: spec.dir, namespace: spec.namespace }).then((reply) => {
        if (cancelled || mine !== latest) return;
        if (reply.ok) setState({ phase: 'ready', error: null, releases: (reply.releases ?? []) as HelmRelease[], refreshing: false });
        else setState((prev) => ({ phase: prev.releases.length > 0 ? 'ready' : 'error', error: { code: String(reply.code ?? 'INTERNAL'), message: reply.error }, releases: prev.releases, refreshing: false }));
      });
    };
    readRef.current = read;
    read();
    return () => {
      cancelled = true;
    };
  }, [key]);

  const items = useMemo(() => state.releases.map(releaseObject), [state.releases]);
  const map = useMemo(() => new Map<string, Obj>(items.map((item) => [objectKey(item), item])), [items]);
  // The cluster answered, so the connection is fine (also when it says no access); the list itself is not live.
  const live = state.phase === 'ready' || state.error?.code === 'FORBIDDEN' ? 'live' : state.phase === 'error' ? 'offline' : 'connecting';
  return { phase: state.phase, error: state.error, live, items, map, info: null, reload: () => readRef.current(), releases: state.releases, refreshing: state.refreshing };
};
