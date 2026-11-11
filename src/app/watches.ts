import type { WatchEvent } from './apply-events.ts';
import { call, host } from './host.ts';

// One place that hears the service's `watch` and `lock` events and keeps every live view's lease alive.
// The lease timer is the only timer in the panel, and it runs only while the panel is visible.

export interface WatchMessage {
  watchId: string;
  state?: 'live' | 'reconnecting' | 'error';
  code?: string;
  events?: WatchEvent[];
}

export interface LockMessage {
  context: string;
  protected: boolean;
  locked: boolean;
  unlockedUntil: number | null;
}

interface Subscriber {
  onMessage: (message: WatchMessage) => void;
  /** The service no longer has this watch (it restarted, or it closed one that missed its lease). Open it again. */
  onUnknown: () => void;
}

export const LEASE_EVERY_MS = 30_000;
const EARLY_KEEP_MS = 5_000;
const EARLY_MAX = 60;

const subscribers = new Map<string, Set<Subscriber>>();
// Events can arrive before the reply that tells the frame the watch id. Keep them briefly and replay them.
const early = new Map<string, { at: number; messages: WatchMessage[] }>();
const lockListeners = new Set<(message: LockMessage) => void>();
let listening = false;
let timer: ReturnType<typeof setInterval> | null = null;

const dispatch = (message: WatchMessage): void => {
  const set = subscribers.get(message.watchId);
  if (set && set.size > 0) {
    for (const subscriber of [...set]) subscriber.onMessage(message);
    return;
  }
  const now = Date.now();
  for (const [id, entry] of early) if (now - entry.at > EARLY_KEEP_MS) early.delete(id);
  const entry = early.get(message.watchId) ?? { at: now, messages: [] };
  if (entry.messages.length < EARLY_MAX) entry.messages.push(message);
  early.set(message.watchId, entry);
};

const listen = (): void => {
  if (listening) return;
  listening = true;
  host.onServiceEvent(({ topic, data }) => {
    if (topic === 'watch') dispatch(data as unknown as WatchMessage);
    else if (topic === 'lock') for (const listener of [...lockListeners]) listener(data as unknown as LockMessage);
  });
  document.addEventListener('visibilitychange', () => {
    sync();
    if (document.visibilityState === 'visible') void renew();
  });
};

export const onLock = (listener: (message: LockMessage) => void): (() => void) => {
  listen();
  lockListeners.add(listener);
  return () => {
    lockListeners.delete(listener);
  };
};

/** Renews every live view's lease. A watch the service dropped is told to open again. */
export const renew = async (): Promise<void> => {
  const ids = [...subscribers.keys()];
  if (ids.length === 0) return;
  const reply = await call('POST', '/watch/lease', { watchIds: ids });
  if (reply.ok || reply.code !== 'UNKNOWN_WATCH') return;
  for (const id of (reply.unknown ?? []) as string[]) for (const subscriber of [...(subscribers.get(id) ?? [])]) subscriber.onUnknown();
};

const sync = (): void => {
  const wanted = document.visibilityState === 'visible' && subscribers.size > 0;
  if (wanted && !timer) timer = setInterval(() => void renew(), LEASE_EVERY_MS);
  if (!wanted && timer) {
    clearInterval(timer);
    timer = null;
  }
};

/** Starts hearing a watch. Returns the function that stops it. */
export const subscribe = (watchId: string, subscriber: Subscriber): (() => void) => {
  listen();
  let set = subscribers.get(watchId);
  if (!set) subscribers.set(watchId, (set = new Set()));
  set.add(subscriber);
  const pending = early.get(watchId);
  if (pending) {
    early.delete(watchId);
    for (const message of pending.messages) subscriber.onMessage(message);
  }
  sync();
  return () => {
    const current = subscribers.get(watchId);
    current?.delete(subscriber);
    if (current && current.size === 0) subscribers.delete(watchId);
    sync();
  };
};
