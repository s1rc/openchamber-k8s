import type { ForwardView } from '../shared/types.ts';
import type { Reply } from '@openchamber-ext/shared-ui';
import type { WatchEvent } from './apply-events.ts';
import { call, host } from './host.ts';
// One place that hears the service's `watch`, `logs`, `forwards` and `lock` events and keeps every
// live view's lease alive. The lease timer is the only timer in the panel, and only while it is visible.

export interface WatchMessage {
  watchId: string;
  state?: 'live' | 'reconnecting' | 'error';
  code?: string;
  events?: WatchEvent[];
}

export interface LogMessage {
  streamId: string;
  lines?: string[];
  state?: 'ended' | 'error';
  code?: string;
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

export interface LogSubscriber {
  onLines: (lines: string[]) => void;
  onEnd: (state: 'ended' | 'error', code?: string) => void;
  onUnknown: () => void;
}

export const LEASE_EVERY_MS = 30_000;
const EARLY_KEEP_MS = 5_000;
const EARLY_MAX = 60;

const subscribers = new Map<string, Set<Subscriber>>();
const logSubscribers = new Map<string, Set<LogSubscriber>>();
// Events can arrive before the reply that tells the frame the watch id. Keep them briefly and replay them.
const early = new Map<string, { at: number; messages: WatchMessage[] }>();
const earlyLogs = new Map<string, { at: number; messages: LogMessage[] }>();
const lockListeners = new Set<(message: LockMessage) => void>();
const forwardListeners = new Set<(forwards: ForwardView[]) => void>();
const leaseListeners = new Set<() => void>();
let listening = false;
let timer: ReturnType<typeof setInterval> | null = null;

const prune = <T>(map: Map<string, { at: number; messages: T[] }>): void => {
  const now = Date.now();
  for (const [id, entry] of map) if (now - entry.at > EARLY_KEEP_MS) map.delete(id);
};

const dispatch = (message: WatchMessage): void => {
  const set = subscribers.get(message.watchId);
  if (set && set.size > 0) {
    for (const subscriber of [...set]) subscriber.onMessage(message);
    return;
  }
  prune(early);
  const entry = early.get(message.watchId) ?? { at: Date.now(), messages: [] };
  if (entry.messages.length < EARLY_MAX) entry.messages.push(message);
  early.set(message.watchId, entry);
};

const dispatchLog = (message: LogMessage): void => {
  const set = logSubscribers.get(message.streamId);
  if (set && set.size > 0) {
    for (const subscriber of [...set]) {
      if (message.lines) subscriber.onLines(message.lines);
      if (message.state) subscriber.onEnd(message.state, message.code);
    }
    return;
  }
  prune(earlyLogs);
  const entry = earlyLogs.get(message.streamId) ?? { at: Date.now(), messages: [] };
  if (entry.messages.length < EARLY_MAX) entry.messages.push(message);
  earlyLogs.set(message.streamId, entry);
};

const listen = (): void => {
  if (listening) return;
  listening = true;
  host.onServiceEvent(({ topic, data }) => {
    if (topic === 'watch') dispatch(data as unknown as WatchMessage);
    else if (topic === 'logs') dispatchLog(data as unknown as LogMessage);
    else if (topic === 'lock') for (const listener of [...lockListeners]) listener(data as unknown as LockMessage);
    else if (topic === 'forwards') for (const listener of [...forwardListeners]) listener((data as unknown as { forwards: ForwardView[] }).forwards ?? []);
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

export const onForwards = (listener: (forwards: ForwardView[]) => void): (() => void) => {
  listen();
  forwardListeners.add(listener);
  return () => {
    forwardListeners.delete(listener);
  };
};

/** Called on every lease tick (every 30 s while the panel is visible, and when it becomes visible). Usage numbers refresh here, so there is still only one timer. */
export const onLeaseTick = (listener: () => void): (() => void) => {
  listen();
  leaseListeners.add(listener);
  return () => {
    leaseListeners.delete(listener);
  };
};

/** Renews every live view's lease. A watch or log stream the service dropped is told to open again. */
export const renew = async (): Promise<void> => {
  for (const listener of [...leaseListeners]) listener();
  const watchIds = [...subscribers.keys()];
  const streamIds = [...logSubscribers.keys()];
  if (watchIds.length === 0 && streamIds.length === 0) return;
  const [watches, logs] = await Promise.all([
    watchIds.length > 0 ? call('POST', '/watch/lease', { watchIds }) : Promise.resolve({ ok: true, unknown: [] as string[], code: undefined } as Reply),
    streamIds.length > 0 ? call('POST', '/logs/lease', { streamIds }) : Promise.resolve({ ok: true, unknown: [] as string[], code: undefined } as Reply),
  ]);
  if (!watches.ok && watches.code === 'UNKNOWN_WATCH') for (const id of (watches.unknown ?? []) as string[]) for (const subscriber of [...(subscribers.get(id) ?? [])]) subscriber.onUnknown();
  if (!logs.ok && logs.code === 'UNKNOWN_WATCH') for (const id of (logs.unknown ?? []) as string[]) for (const subscriber of [...(logSubscribers.get(id) ?? [])]) subscriber.onUnknown();
};

const sync = (): void => {
  const wanted = document.visibilityState === 'visible' && (subscribers.size > 0 || logSubscribers.size > 0);
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

/** Starts hearing one log stream. Returns the function that stops hearing it. */
export const subscribeLogs = (streamId: string, subscriber: LogSubscriber): (() => void) => {
  listen();
  let set = logSubscribers.get(streamId);
  if (!set) logSubscribers.set(streamId, (set = new Set()));
  set.add(subscriber);
  const pending = earlyLogs.get(streamId);
  if (pending) {
    earlyLogs.delete(streamId);
    for (const message of pending.messages) {
      if (message.lines) subscriber.onLines(message.lines);
      if (message.state) subscriber.onEnd(message.state, message.code);
    }
  }
  sync();
  return () => {
    const current = logSubscribers.get(streamId);
    current?.delete(subscriber);
    if (current && current.size === 0) logSubscribers.delete(streamId);
    sync();
  };
};
