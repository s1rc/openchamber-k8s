import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chartSpecs, limitSeries, parseRange, promCandidates, proxyBase, type ChartQuery, type ChartScope, type ChartUnit, type PromService, type Series } from '../shared/prom.ts';
import type { Obj, Target } from '../shared/types.ts';
import { childEnv } from './bins.ts';
import { clip, fromOutput, K8sError } from './errors.ts';
import { kubeconfigArgs, kubectlPath } from './exec.ts';
import { freePort } from './forwards.ts';
import { call, callJson, type Reply } from './k8s.ts';
import { targetKey } from './proxy.ts';
import { readJson, sockDir, writeJson } from './state.ts';

// Prometheus for history charts. The plan reaches it through the API server's service proxy. Some clusters block that
// path to pod ports (staging does), so when the proxy does not answer the service falls back to a short-lived
// `kubectl port-forward` of its own. That forward is not in the Port forwarding list and stops after 5 idle minutes.

const PROBE_MS = 6000;
const QUERY_MS = 20_000;
const FOUND_MS = 10 * 60_000;
const MISSING_MS = 60_000;
const IDLE_MS = 5 * 60_000;
const FORWARD_START_MS = 15_000;
const CHART_CACHE_MS = 15_000;
const STEP_SECONDS = 60;
const WINDOW_SECONDS = 3600;
const OVERRIDES = 'prometheus.json';

export type Via = 'proxy' | 'forward';

export type Detection =
  | { found: true; service: PromService; via: Via; source: 'detected' | 'override' }
  | { found: false; reason: 'none' | 'forbidden' | 'unreachable'; tried: PromService[]; source: 'detected' | 'override' };

const detections = new Map<string, { at: number; value: Detection }>();
const inflight = new Map<string, Promise<Detection>>();

// ----- The user's choice of service, per context

const readOverrides = (): Record<string, PromService> => {
  const all = readJson<Record<string, PromService>>(OVERRIDES, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
};

export const readOverride = (context: string): PromService | null => {
  const found = readOverrides()[context];
  return found && typeof found.namespace === 'string' && typeof found.name === 'string' && typeof found.port === 'string' ? found : null;
};

export const writeOverride = (context: string, service: PromService | null): void => {
  const all = { ...readOverrides() };
  if (service) all[context] = service;
  else delete all[context];
  writeJson(OVERRIDES, all);
};

// ----- Talking to the server

const localGet = (port: number, path: string, query: Record<string, string>, timeoutMs: number): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const qs = new URLSearchParams(query).toString();
    const req = http.request({ host: '127.0.0.1', port, path: qs ? `${path}?${qs}` : path, method: 'GET', headers: { Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Prometheus took too long to answer.')));
    req.on('error', reject);
    req.end();
  });

interface Hidden {
  key: string;
  child: ChildProcess;
  ready: Promise<number>;
  lastUsed: number;
  exited: boolean;
  pidFile: string;
}

const hidden = new Map<string, Hidden>();
let sweeper: ReturnType<typeof setInterval> | null = null;

const stopHidden = (entry: Hidden): void => {
  entry.exited = true;
  hidden.delete(entry.key);
  entry.child.kill('SIGTERM');
  rmSync(entry.pidFile, { force: true });
};

const sweep = (): void => {
  const now = Date.now();
  for (const entry of [...hidden.values()]) if (now - entry.lastUsed > IDLE_MS) stopHidden(entry);
  if (hidden.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
};

/** A service port as a number, so kubectl port-forward accepts it. A port name is looked up on the Service. */
const portNumber = async (target: Target, service: PromService): Promise<number> => {
  if (/^[0-9]+$/.test(service.port)) return Number(service.port);
  const object = await callJson(target, { path: `/api/v1/namespaces/${encodeURIComponent(service.namespace)}/services/${encodeURIComponent(service.name)}` });
  const found = ((object.spec?.ports ?? []) as Obj[]).find((port) => port.name === service.port);
  if (!found || typeof found.port !== 'number') throw new K8sError('NOT_FOUND', `${service.namespace}/${service.name} has no port named "${service.port}".`);
  return found.port;
};

/** The local port of a hidden forward to the service, started on first use. */
const ensureForward = async (target: Target, service: PromService): Promise<number> => {
  const key = `${targetKey(target)}|${service.namespace}/${service.name}:${service.port}`;
  const existing = hidden.get(key);
  if (existing && !existing.exited) {
    existing.lastUsed = Date.now();
    return existing.ready;
  }
  const remote = await portNumber(target, service);
  const local = await freePort();
  const id = createHash('sha1').update(key).digest('hex').slice(0, 10);
  const child = spawn(kubectlPath(), ['--context', target.context, ...kubeconfigArgs(target.kubeconfig), '-n', service.namespace, 'port-forward', `svc/${service.name}`, `${local}:${remote}`, '--address', '127.0.0.1'], {
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pidFile = join(sockDir(), `fwd-prom-${id}.pid`);
  if (child.pid) {
    try {
      writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
    } catch {
      // The pid file only helps clean up after a crash.
    }
  }
  const entry: Hidden = { key, child, ready: Promise.resolve(local), lastUsed: Date.now(), exited: false, pidFile };
  let output = '';
  entry.ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new K8sError('UNREACHABLE', 'The connection to Prometheus did not open in time.'));
      stopHidden(entry);
    }, FORWARD_START_MS);
    const onData = (chunk: Buffer): void => {
      output = (output + String(chunk)).slice(-2000);
      if (/Forwarding from/.test(output)) {
        clearTimeout(timer);
        resolve(local);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new K8sError('NO_KUBECTL', clip(error.message), { kind: 'install' }));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      entry.exited = true;
      hidden.delete(key);
      rmSync(pidFile, { force: true });
      reject(fromOutput(output, 'The connection to Prometheus stopped.', target.context));
    });
  });
  entry.ready.catch(() => undefined);
  hidden.set(key, entry);
  if (!sweeper) {
    sweeper = setInterval(sweep, 60_000);
    sweeper.unref();
  }
  return entry.ready;
};

export const closePrometheusForwards = (): void => {
  for (const entry of [...hidden.values()]) stopHidden(entry);
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
};

export const hiddenForwardCount = (): number => hidden.size;

const fetchProm = async (target: Target, found: Extract<Detection, { found: true }>, path: string, query: Record<string, string>, timeoutMs: number): Promise<Reply> => {
  if (found.via === 'proxy') return call(target, { path: `${proxyBase(found.service)}${path}`, query, timeoutMs });
  const port = await ensureForward(target, found.service);
  return localGet(port, path, query, timeoutMs);
};

const answersQueries = (reply: Reply): boolean => {
  if (reply.status !== 200) return false;
  try {
    return (JSON.parse(reply.text) as Obj).status === 'success';
  } catch {
    return false;
  }
};

const mustRethrow = (error: unknown): boolean => error instanceof K8sError && (error.code === 'AUTH_EXPIRED' || error.code === 'NO_KUBECTL');

// ----- Finding it

const detectNow = async (target: Target): Promise<Detection> => {
  const override = readOverride(target.context);
  let candidates: PromService[];
  if (override) candidates = [override];
  else {
    try {
      const services = await callJson(target, { path: '/api/v1/services', timeoutMs: 60_000 });
      candidates = promCandidates((services.items ?? []) as Obj[]).slice(0, 2);
    } catch (error) {
      if (error instanceof K8sError && error.code === 'FORBIDDEN') return { found: false, reason: 'forbidden', tried: [], source: 'detected' };
      throw error;
    }
  }
  const source = override ? 'override' : 'detected';
  if (candidates.length === 0) return { found: false, reason: 'none', tried: [], source };
  for (const service of candidates) {
    for (const via of ['proxy', 'forward'] as const) {
      try {
        const reply = await fetchProm(target, { found: true, service, via, source }, '/api/v1/query', { query: 'vector(1)' }, PROBE_MS);
        if (answersQueries(reply)) return { found: true, service, via, source };
      } catch (error) {
        if (mustRethrow(error)) throw error;
      }
    }
  }
  return { found: false, reason: 'unreachable', tried: candidates, source };
};

/** Finds the Prometheus of a cluster, and how to reach it. The answer is kept for 10 minutes (1 minute when nothing was found). */
export const detect = async (target: Target, force = false): Promise<Detection> => {
  const key = targetKey(target);
  const hit = detections.get(key);
  if (!force && hit && Date.now() - hit.at < (hit.value.found ? FOUND_MS : MISSING_MS)) return hit.value;
  const running = inflight.get(key);
  if (running) return running;
  const job = detectNow(target)
    .then((value) => {
      detections.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
};

export const forgetDetection = (target: Target): void => {
  detections.delete(targetKey(target));
};

// ----- Charts

export interface ChartAnswer {
  id: string;
  title: string;
  unit: ChartUnit;
  series: Series[];
  hidden: number;
  /** What the chart shows when it is not the usual thing. */
  note?: string;
  error?: string;
}

export interface ChartsAnswer {
  available: boolean;
  reason?: 'none' | 'forbidden' | 'unreachable';
  via?: Via;
  service?: string;
  start: number;
  end: number;
  step: number;
  charts: ChartAnswer[];
}

const chartCache = new Map<string, { at: number; value: ChartsAnswer }>();

const promError = (reply: Reply): string => {
  try {
    const body = JSON.parse(reply.text) as Obj;
    if (typeof body.error === 'string') return clip(body.error, 160);
  } catch {
    // Not JSON.
  }
  return `Prometheus answered ${reply.status}.`;
};

/** The last hour of CPU, memory, network and filesystem for a pod, workload or node. */
export const readCharts = async (target: Target, scope: ChartScope): Promise<ChartsAnswer> => {
  let specs;
  try {
    specs = chartSpecs(scope);
  } catch (error) {
    throw new K8sError('BAD_REQUEST', error instanceof Error ? error.message : 'Not a valid chart request.');
  }
  const cacheKey = `${targetKey(target)}|${JSON.stringify(scope)}`;
  const hit = chartCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CHART_CACHE_MS) return hit.value;
  const end = Math.floor(Date.now() / 1000 / STEP_SECONDS) * STEP_SECONDS;
  const start = end - WINDOW_SECONDS;
  const base = { start, end, step: STEP_SECONDS };
  const found = await detect(target);
  if (!found.found) return { ...base, available: false, reason: found.reason, charts: [] };
  const charts = await Promise.all(
    specs.map(async (spec): Promise<ChartAnswer> => {
      try {
        const run = async (queries: ChartQuery[]): Promise<Series[]> => {
          const lists = await Promise.all(
            queries.map(async (query) => {
              const reply = await fetchProm(target, found, '/api/v1/query_range', { query: query.query, start: String(start), end: String(end), step: `${STEP_SECONDS}s` }, QUERY_MS);
              if (reply.status !== 200) throw new K8sError('K8S_ERROR', promError(reply));
              return parseRange(JSON.parse(reply.text) as unknown, query);
            }),
          );
          return lists.flat();
        };
        let all = await run(spec.queries);
        let note: string | undefined;
        if (all.length === 0 && spec.fallback) {
          all = await run(spec.fallback.queries);
          if (all.length > 0) note = spec.fallback.note;
        }
        const limited = limitSeries(all);
        return { id: spec.id, title: spec.title, unit: spec.unit, series: limited.series, hidden: limited.hidden, ...(note ? { note } : {}) };
      } catch (error) {
        if (mustRethrow(error)) throw error;
        return { id: spec.id, title: spec.title, unit: spec.unit, series: [], hidden: 0, error: error instanceof Error ? clip(error.message, 160) : 'Could not read this chart.' };
      }
    }),
  );
  // Every chart failed: the way in probably changed (a forward died, the server moved). Look again next time.
  if (charts.every((chart) => chart.error)) forgetDetection(target);
  const answer: ChartsAnswer = { ...base, available: true, via: found.via, service: `${found.service.namespace}/${found.service.name}`, charts };
  chartCache.set(cacheKey, { at: Date.now(), value: answer });
  if (chartCache.size > 100) for (const [old, entry] of chartCache) if (Date.now() - entry.at > CHART_CACHE_MS) chartCache.delete(old);
  return answer;
};

/** What the panel shows about the detection. */
export const describeDetection = (found: Detection): Obj =>
  found.found
    ? { found: true, namespace: found.service.namespace, service: found.service.name, port: found.service.port, via: found.via, source: found.source }
    : { found: false, reason: found.reason, source: found.source, tried: found.tried.map((service) => `${service.namespace}/${service.name}:${service.port}`) };
