import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { KindInfo } from '../shared/kinds.ts';
import type { Obj } from '../shared/types.ts';
import type { ErrorInfo } from './errors.tsx';
import { call } from './host.ts';
import { applyEvents, objectKey } from './apply-events.ts';
import { subscribe, type WatchMessage } from './watches.ts';

export type Live = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface WatchSpec {
  context: string;
  /** `_all` for every namespace. */
  namespace: string;
  kind: string;
  dir: string | null;
  /** Only objects the cluster says match, e.g. `type=Warning` for events. */
  fieldSelector?: string;
}

export interface WatchView {
  phase: 'loading' | 'ready' | 'error';
  error: ErrorInfo | null;
  live: Live;
  items: Obj[];
  map: Map<string, Obj>;
  info: KindInfo | null;
  reload: () => void;
}

const STALE_MS = 800;

interface Holder {
  phase: WatchView['phase'];
  error: ErrorInfo | null;
  live: Live;
  map: Map<string, Obj>;
  info: KindInfo | null;
}

/**
 * A live list of one kind. The service sends a snapshot, then pushes changes; this keeps the map in step.
 * Nothing here polls: the lease timer in watches.ts keeps the watch alive while the panel is visible.
 */
export const useWatch = (spec: WatchSpec | null): WatchView => {
  const [, setTick] = useState(0);
  const bump = (): void => setTick((n) => n + 1);
  const holder = useRef<Holder>({ phase: 'loading', error: null, live: 'connecting', map: new Map(), info: null });
  const reloadRef = useRef<() => void>(() => undefined);
  const key = spec ? `${spec.context}|${spec.namespace}|${spec.kind}|${spec.dir ?? ''}|${spec.fieldSelector ?? ''}` : '';

  useEffect(() => {
    holder.current = { phase: 'loading', error: null, live: 'connecting', map: new Map(), info: null };
    bump();
    if (!spec) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    let stale: Set<string> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const fetchOne = async (namespace: string, name: string): Promise<void> => {
      const reply = await call('GET', '/get', { context: spec.context, dir: spec.dir, kind: spec.kind, namespace: namespace || '_all', name });
      if (cancelled || !reply.ok) return;
      holder.current.map.set(objectKey(reply.object as Obj), reply.object as Obj);
      commit();
    };

    // The map changes identity on every change, so memoized rows know to rebuild.
    const commit = (): void => {
      holder.current.map = new Map(holder.current.map);
      bump();
    };

    const onMessage = (message: WatchMessage): void => {
      const h = holder.current;
      if (message.state) {
        if (message.state === 'error') {
          h.phase = 'error';
          h.error = { code: message.code ?? 'INTERNAL' };
          h.live = 'offline';
        } else h.live = message.state;
      }
      if (message.events) {
        const result = applyEvents(h.map, message.events, stale);
        stale = result.stale;
        for (const one of result.refetch) void fetchOne(one.namespace, one.name);
        if (stale && !staleTimer) {
          staleTimer = setTimeout(() => {
            staleTimer = null;
            for (const gone of stale ?? []) holder.current.map.delete(gone);
            stale = null;
            commit();
          }, STALE_MS);
        }
      }
      commit();
    };

    const open = async (): Promise<void> => {
      const mine = ++attempt;
      const reply = await call('POST', '/watch', { context: spec.context, namespace: spec.namespace, kind: spec.kind, dir: spec.dir, fieldSelector: spec.fieldSelector });
      if (cancelled || mine !== attempt) return;
      const h = holder.current;
      if (!reply.ok) {
        h.phase = 'error';
        h.error = { code: String(reply.code ?? 'INTERNAL'), message: reply.error };
        h.live = 'offline';
        bump();
        return;
      }
      stop?.();
      h.map = new Map((reply.items as Obj[]).map((item) => [objectKey(item), item]));
      h.info = reply.kind as KindInfo;
      h.phase = 'ready';
      h.error = null;
      h.live = 'live';
      stale = null;
      stop = subscribe(String(reply.watchId), { onMessage, onUnknown: () => void open() });
      bump();
    };

    reloadRef.current = () => {
      holder.current.phase = holder.current.map.size > 0 ? holder.current.phase : 'loading';
      holder.current.error = null;
      holder.current.live = 'connecting';
      bump();
      void open();
    };
    void open();
    return () => {
      cancelled = true;
      stop?.();
      if (staleTimer) clearTimeout(staleTimer);
    };
  }, [key]);

  const h = holder.current;
  const items = useMemo(() => [...h.map.values()], [h.map]);
  return { phase: h.phase, error: h.error, live: h.live, items, map: h.map, info: h.info, reload: () => reloadRef.current() };
};
