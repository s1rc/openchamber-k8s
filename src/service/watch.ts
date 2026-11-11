import { createHash } from 'node:crypto';
import { isSecret, kindPath, type KindInfo } from '../shared/kinds.ts';
import { forPanel } from '../shared/redact.ts';
import type { Obj, Target } from '../shared/types.ts';
import { K8sError, toReply } from './errors.ts';
import { callJson, openStream, type StreamHandle } from './k8s.ts';
import { targetKey } from './proxy.ts';

export type Emit = (topic: string, data: unknown) => Promise<void>;

const BATCH_MS = 250;
const LEASE_MS = 60_000;
const SWEEP_MS = 15_000;
const EMIT_GAP_MS = 40;
const EMIT_CHARS = 60_000;

let emitFn: Emit = async () => undefined;
export const setEmitter = (fn: Emit): void => {
  emitFn = fn;
};

// Everything leaves through one queue: the host allows 30 emits a second, this sends at most 25.
const outbox: { topic: string; data: unknown }[] = [];
let outboxTimer: ReturnType<typeof setInterval> | null = null;

const send = (topic: string, data: unknown): void => {
  outbox.push({ topic, data });
  if (outboxTimer) return;
  outboxTimer = setInterval(() => {
    const next = outbox.shift();
    if (!next) {
      if (outboxTimer) clearInterval(outboxTimer);
      outboxTimer = null;
      return;
    }
    emitFn(next.topic, next.data).catch(() => undefined);
  }, EMIT_GAP_MS);
};

export interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RESET';
  object?: Obj;
  /** The object was too big to push; fetch it with GET /get. */
  large?: boolean;
  namespace?: string;
  name?: string;
}

/** Splits events into emits that stay under the size limit. */
export const chunkEvents = (events: WatchEvent[], limit = EMIT_CHARS): WatchEvent[][] => {
  const chunks: WatchEvent[][] = [];
  let current: WatchEvent[] = [];
  let size = 0;
  for (let event of events) {
    let length = JSON.stringify(event).length;
    if (length > limit) {
      event = { type: event.type, large: true, namespace: event.object?.metadata?.namespace, name: event.object?.metadata?.name };
      length = JSON.stringify(event).length;
    }
    if (current.length > 0 && size + length + 1 > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(event);
    size += length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

type State = 'live' | 'reconnecting' | 'error';

interface Watch {
  id: string;
  key: string;
  target: Target;
  info: KindInfo;
  namespace: string | null;
  store: Map<string, Obj>;
  rv: string;
  leaseAt: number;
  closed: boolean;
  stream: StreamHandle | null;
  pending: WatchEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  backoff: number;
  ready: Promise<void>;
}

const watches = new Map<string, Watch>();
let sweeper: ReturnType<typeof setInterval> | null = null;

const objectKey = (object: Obj): string => `${object.metadata?.namespace ?? ''}/${object.metadata?.name ?? ''}`;

const prepare = (w: Watch, object: Obj): Obj => {
  const withKind: Obj = { apiVersion: w.info.group ? `${w.info.group}/${w.info.version}` : w.info.version, kind: w.info.kind, ...object };
  return forPanel(isSecret(w.info), withKind);
};

const setState = (w: Watch, state: State, code?: string): void => {
  send('watch', { watchId: w.id, state, ...(code ? { code } : {}) });
};

const flush = (w: Watch): void => {
  w.flushTimer = null;
  const events = w.pending;
  w.pending = [];
  for (const chunk of chunkEvents(events)) send('watch', { watchId: w.id, events: chunk });
};

const queueEvent = (w: Watch, event: WatchEvent): void => {
  w.pending.push(event);
  if (!w.flushTimer) w.flushTimer = setTimeout(() => flush(w), BATCH_MS);
};

const list = async (w: Watch): Promise<void> => {
  const answer = await callJson(w.target, { path: kindPath(w.info, w.namespace), timeoutMs: 60_000 });
  w.store = new Map();
  for (const item of (answer.items ?? []) as Obj[]) {
    const object = prepare(w, item);
    w.store.set(objectKey(object), object);
  }
  w.rv = String(answer.metadata?.resourceVersion ?? '');
};

const onLine = (w: Watch, line: string): void => {
  let event: { type?: string; object?: Obj };
  try {
    event = JSON.parse(line) as { type?: string; object?: Obj };
  } catch {
    return;
  }
  const object = event.object;
  if (!object) return;
  if (event.type === 'BOOKMARK') {
    w.rv = String(object.metadata?.resourceVersion ?? w.rv);
    return;
  }
  if (event.type === 'ERROR') {
    if (object.code === 410) void relist(w);
    return;
  }
  if (event.type !== 'ADDED' && event.type !== 'MODIFIED' && event.type !== 'DELETED') return;
  const prepared = prepare(w, object);
  w.rv = String(object.metadata?.resourceVersion ?? w.rv);
  if (event.type === 'DELETED') w.store.delete(objectKey(prepared));
  else w.store.set(objectKey(prepared), prepared);
  queueEvent(w, { type: event.type, object: prepared });
};

const schedule = (w: Watch, delay: number): void => {
  if (w.closed || w.retryTimer) return;
  w.retryTimer = setTimeout(() => {
    w.retryTimer = null;
    void connect(w);
  }, delay);
};

const failed = (w: Watch, error: unknown): void => {
  const reply = toReply(error);
  // Signing in again or changing permissions needs the user: stop retrying so nothing keeps opening a browser.
  if (reply.code === 'AUTH_EXPIRED' || reply.code === 'FORBIDDEN' || reply.code === 'NOT_FOUND' || reply.code === 'NO_KUBECTL') {
    setState(w, 'error', reply.code);
    closeWatch(w);
    return;
  }
  if (error instanceof K8sError && error.status === 410) {
    void relist(w);
    return;
  }
  setState(w, 'reconnecting', reply.code);
  w.backoff = Math.min(w.backoff * 2, 30_000);
  schedule(w, w.backoff);
};

const connect = async (w: Watch): Promise<void> => {
  if (w.closed) return;
  try {
    w.stream = await openStream(
      w.target,
      kindPath(w.info, w.namespace),
      { watch: 'true', resourceVersion: w.rv, allowWatchBookmarks: 'true', timeoutSeconds: '600' },
      (line) => onLine(w, line),
      (error) => {
        w.stream = null;
        if (w.closed) return;
        if (error) setState(w, 'reconnecting');
        schedule(w, error ? w.backoff : 200);
      },
    );
    if (w.closed) {
      w.stream.abort();
      return;
    }
    w.backoff = 1000;
    setState(w, 'live');
  } catch (error) {
    failed(w, error);
  }
};

const relist = async (w: Watch): Promise<void> => {
  if (w.closed) return;
  w.stream?.abort();
  w.stream = null;
  try {
    await list(w);
  } catch (error) {
    failed(w, error);
    return;
  }
  const events: WatchEvent[] = [{ type: 'RESET' }, ...[...w.store.values()].map((object) => ({ type: 'ADDED' as const, object }))];
  w.pending = [];
  if (w.flushTimer) clearTimeout(w.flushTimer);
  w.flushTimer = null;
  for (const chunk of chunkEvents(events)) send('watch', { watchId: w.id, events: chunk });
  await connect(w);
};

const closeWatch = (w: Watch): void => {
  w.closed = true;
  w.stream?.abort();
  w.stream = null;
  if (w.flushTimer) clearTimeout(w.flushTimer);
  if (w.retryTimer) clearTimeout(w.retryTimer);
  w.flushTimer = null;
  w.retryTimer = null;
  if (watches.get(w.key) === w) watches.delete(w.key);
  if (watches.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
};

const ensureSweeper = (): void => {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const w of [...watches.values()]) if (now - w.leaseAt > LEASE_MS) closeWatch(w);
  }, SWEEP_MS);
  sweeper.unref();
};

export interface Snapshot {
  watchId: string;
  items: Obj[];
  resourceVersion: string;
}

/** Starts, or joins, the watch for this cluster, namespace and kind. Answers the current items first. */
export const openWatch = async (target: Target, info: KindInfo, namespace: string | null): Promise<Snapshot> => {
  const key = `${targetKey(target)}|${namespace ?? ''}|${info.group}/${info.plural}`;
  let w = watches.get(key);
  if (!w || w.closed) {
    const id = `w_${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
    const created: Watch = {
      id,
      key,
      target,
      info,
      namespace: info.namespaced ? namespace : null,
      store: new Map(),
      rv: '',
      leaseAt: Date.now(),
      closed: false,
      stream: null,
      pending: [],
      flushTimer: null,
      retryTimer: null,
      backoff: 1000,
      ready: Promise.resolve(),
    };
    created.ready = list(created).then(() => connect(created));
    watches.set(key, created);
    ensureSweeper();
    w = created;
    try {
      await created.ready;
    } catch (error) {
      closeWatch(created);
      throw error;
    }
  } else await w.ready;
  w.leaseAt = Date.now();
  return { watchId: w.id, items: [...w.store.values()], resourceVersion: w.rv };
};

export const renewLeases = (ids: string[]): { known: string[]; unknown: string[] } => {
  const known: string[] = [];
  const unknown: string[] = [];
  const byId = new Map([...watches.values()].map((w) => [w.id, w]));
  const now = Date.now();
  for (const id of ids) {
    const w = byId.get(id);
    if (w && !w.closed) {
      w.leaseAt = now;
      known.push(id);
    } else unknown.push(id);
  }
  return { known, unknown };
};

export const closeAllWatches = (): void => {
  for (const w of [...watches.values()]) closeWatch(w);
};

export const watchCount = (): number => watches.size;
