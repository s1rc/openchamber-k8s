import { createHash } from 'node:crypto';
import type { Target } from '../shared/types.ts';
import { K8sError, toReply } from './errors.ts';
import { openStream, type StreamHandle } from './k8s.ts';
import { publish } from './watch.ts';

// Log follow streams. They use the same batching and the same 60 second lease as watches, so a closed
// panel never leaves a kubectl log request running.

const BATCH_MS = 250;
const LEASE_MS = 60_000;
const SWEEP_MS = 15_000;
const EMIT_CHARS = 60_000;
const LINE_MAX = 8_000;
const TAIL_MAX = 5_000;

export interface LogRequest {
  target: Target;
  namespace: string;
  pod: string;
  container?: string;
  previous: boolean;
  timestamps: boolean;
  tailLines: number;
}

interface LogStream {
  id: string;
  key: string;
  request: LogRequest;
  leaseAt: number;
  closed: boolean;
  stream: StreamHandle | null;
  pending: string[];
  pendingChars: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const streams = new Map<string, LogStream>();
let sweeper: ReturnType<typeof setInterval> | null = null;
let counter = 0;

const clip = (line: string): string => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)} [line shortened]` : line);

const flush = (stream: LogStream): void => {
  stream.flushTimer = null;
  const lines = stream.pending;
  stream.pending = [];
  stream.pendingChars = 0;
  if (lines.length === 0 || stream.closed) return;
  let chunk: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (chunk.length > 0 && size + line.length + 1 > EMIT_CHARS) {
      publish('logs', { streamId: stream.id, lines: chunk });
      chunk = [];
      size = 0;
    }
    chunk.push(line);
    size += line.length + 1;
  }
  if (chunk.length > 0) publish('logs', { streamId: stream.id, lines: chunk });
};

const queue = (stream: LogStream, line: string): void => {
  const text = clip(line);
  stream.pending.push(text);
  stream.pendingChars += text.length + 1;
  if (stream.pendingChars >= EMIT_CHARS) {
    if (stream.flushTimer) clearTimeout(stream.flushTimer);
    flush(stream);
    return;
  }
  if (!stream.flushTimer) stream.flushTimer = setTimeout(() => flush(stream), BATCH_MS);
};

const close = (stream: LogStream, state?: 'ended' | 'error', code?: string): void => {
  if (stream.closed) return;
  stream.closed = true;
  stream.stream?.abort();
  stream.stream = null;
  if (stream.flushTimer) clearTimeout(stream.flushTimer);
  stream.flushTimer = null;
  flush(stream);
  if (state) publish('logs', { streamId: stream.id, state, ...(code ? { code } : {}) });
  if (streams.get(stream.id) === stream) streams.delete(stream.id);
  if (streams.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
};

const ensureSweeper = (): void => {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const stream of [...streams.values()]) if (now - stream.leaseAt > LEASE_MS) close(stream);
  }, SWEEP_MS);
  sweeper.unref();
};

export interface LogHandle {
  streamId: string;
}

/** Starts a follow stream for one container. Lines arrive as `logs` events. */
export const startLogs = async (request: LogRequest): Promise<LogHandle> => {
  const key = `${request.target.kubeconfig ?? ''}|${request.target.context}|${request.namespace}|${request.pod}|${request.container ?? ''}|${request.previous ? 'previous' : ''}`;
  const id = `l_${createHash('sha1').update(`${key}|${++counter}`).digest('hex').slice(0, 12)}`;
  const stream: LogStream = {
    id,
    key,
    request,
    leaseAt: Date.now(),
    closed: false,
    stream: null,
    pending: [],
    pendingChars: 0,
    flushTimer: null,
  };
  const tail = Math.min(TAIL_MAX, Math.max(1, Math.trunc(request.tailLines) || 500));
  try {
    stream.stream = await openStream(
      request.target,
      `/api/v1/namespaces/${encodeURIComponent(request.namespace)}/pods/${encodeURIComponent(request.pod)}/log`,
      {
        follow: 'true',
        container: request.container,
        previous: request.previous ? 'true' : undefined,
        timestamps: request.timestamps ? 'true' : undefined,
        tailLines: String(tail),
      },
      (line) => queue(stream, line),
      (error) => close(stream, error ? 'error' : 'ended', error ? toReply(error).code : undefined),
    );
  } catch (error) {
    if (error instanceof K8sError) throw error;
    throw error;
  }
  if (stream.closed) return { streamId: id };
  streams.set(id, stream);
  ensureSweeper();
  return { streamId: id };
};

export const stopLogs = (id: string): void => {
  const stream = streams.get(id);
  if (stream) close(stream);
};

export const renewLogLeases = (ids: string[]): { known: string[]; unknown: string[] } => {
  const known: string[] = [];
  const unknown: string[] = [];
  const now = Date.now();
  for (const id of ids) {
    const stream = streams.get(id);
    if (stream && !stream.closed) {
      stream.leaseAt = now;
      known.push(id);
    } else unknown.push(id);
  }
  return { known, unknown };
};

export const closeAllLogs = (): void => {
  for (const stream of [...streams.values()]) close(stream);
};

export const logCount = (): number => streams.size;
