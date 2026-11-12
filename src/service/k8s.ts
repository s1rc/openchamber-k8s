import http from 'node:http';
import { findKind, findKindByApiVersion, type KindInfo } from '../shared/kinds.ts';
import type { Obj, Target } from '../shared/types.ts';
import { classifyText, clip, fromHttp, fromOutput, K8sError } from './errors.ts';
import { ensureProxy, proxyOutput, stopProxy, targetKey, touchProxy, trackStream } from './proxy.ts';

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | undefined>;
  body?: string;
  contentType?: string;
  timeoutMs?: number;
}

export interface Reply {
  status: number;
  text: string;
}

const withQuery = (path: string, query: CallOptions['query']): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== '') params.set(key, value);
  const text = params.toString();
  return text ? `${path}?${text}` : path;
};

const once = (socketPath: string, options: CallOptions): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    }
    const req = http.request({ socketPath, path: withQuery(options.path, options.query), method: options.method ?? 'GET', headers, timeout: options.timeoutMs ?? 30000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('The cluster took too long to answer.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

const isSocketGone = (error: unknown): boolean => ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(String((error as { code?: unknown }).code));

/** One REST call to a cluster through its proxy. A dead proxy is restarted once. */
export const call = async (target: Target, options: CallOptions): Promise<Reply> => {
  let socket = await ensureProxy(target);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await once(socket, options);
      touchProxy(target);
      return reply;
    } catch (error) {
      if (attempt === 0 && isSocketGone(error)) {
        stopProxy(targetKey(target));
        socket = await ensureProxy(target);
        continue;
      }
      const code = (error as { code?: unknown }).code;
      if (code === 'ETIMEDOUT') throw new K8sError('UNREACHABLE', 'The cluster took too long to answer. Check your network or VPN.');
      throw fromOutput(`${(error as Error).message} ${proxyOutput(target)}`, 'Could not reach the cluster.', target.context);
    }
  }
};

/** Like `call`, but parses JSON and turns a failure status into an error. */
export const callJson = async (target: Target, options: CallOptions): Promise<Obj> => {
  const reply = await call(target, options);
  if (reply.status >= 400 || reply.status === 0) {
    const fromProxy = classifyText(proxyOutput(target));
    const error = fromHttp(reply.status, reply.text, target.context);
    if (error.code === 'K8S_ERROR' && fromProxy === 'AUTH_EXPIRED') throw fromOutput(proxyOutput(target), error.message, target.context);
    throw error;
  }
  try {
    return reply.text ? (JSON.parse(reply.text) as Obj) : {};
  } catch {
    throw new K8sError('K8S_ERROR', 'The cluster answered something unreadable.');
  }
};

export interface StreamHandle {
  abort: () => void;
}

/** Opens a long-lived GET (watch, log follow) and hands over each line. Resolves once the cluster answered 200. */
export const openStream = async (
  target: Target,
  path: string,
  query: CallOptions['query'],
  onLine: (line: string) => void,
  onEnd: (error?: Error) => void,
): Promise<StreamHandle> => {
  const socketPath = await ensureProxy(target);
  return new Promise((resolve, reject) => {
    let settled = false;
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      trackStream(target, -1);
      if (settled) onEnd(error);
    };
    const req = http.request({ socketPath, path: withQuery(path, query), method: 'GET', headers: { Accept: 'application/json' } }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          done = true;
          trackStream(target, -1);
          settled = true;
          reject(fromHttp(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'), target.context));
        });
        return;
      }
      settled = true;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let at = buffer.indexOf('\n');
        while (at >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (line.trim()) onLine(line);
          at = buffer.indexOf('\n');
        }
      });
      res.on('end', () => finish());
      res.on('error', (error) => finish(error));
      resolve({ abort: () => req.destroy() });
    });
    trackStream(target, 1);
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        done = true;
        trackStream(target, -1);
        reject(fromOutput(`${error.message} ${proxyOutput(target)}`, 'Could not reach the cluster.', target.context));
      } else {
        finish(error);
      }
    });
    req.end();
  });
};

interface Resource {
  name: string;
  singularName?: string;
  namespaced: boolean;
  kind: string;
  shortNames?: string[];
  verbs?: string[];
}

const discovery = new Map<string, { at: number; kinds: KindInfo[] }>();
const DISCOVERY_MS = 10 * 60 * 1000;

const fromResources = (group: string, version: string, resources: Resource[]): KindInfo[] =>
  resources
    .filter((resource) => !resource.name.includes('/'))
    .map((resource) => ({ kind: resource.kind, plural: resource.name, group, version, namespaced: resource.namespaced, aliases: [...(resource.shortNames ?? []), ...(resource.singularName ? [resource.singularName] : [])].map((text) => text.toLowerCase()) }));

/** Drops the kept discovery of a cluster, so a CRD installed a moment ago is found. */
export const forgetDiscovery = (target: Target): void => {
  discovery.delete(targetKey(target));
};

/** Every kind the cluster serves, found through discovery and kept for ten minutes. */
export const discoverAll = async (target: Target): Promise<KindInfo[]> => {
  const key = targetKey(target);
  const hit = discovery.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_MS) return hit.kinds;
  const kinds: KindInfo[] = [];
  const core = await callJson(target, { path: '/api/v1' });
  kinds.push(...fromResources('', 'v1', (core.resources ?? []) as Resource[]));
  const groups = await callJson(target, { path: '/apis' });
  await Promise.all(
    ((groups.groups ?? []) as Obj[]).map(async (group) => {
      const preferred = group.preferredVersion?.groupVersion as string | undefined;
      if (!preferred) return;
      try {
        const list = await callJson(target, { path: `/apis/${preferred}` });
        kinds.push(...fromResources(String(group.name), preferred.slice(preferred.indexOf('/') + 1), (list.resources ?? []) as Resource[]));
      } catch {
        // A group whose discovery fails (aggregated API down) is skipped, not fatal.
      }
    }),
  );
  discovery.set(key, { at: Date.now(), kinds });
  return kinds;
};

/** Finds the REST details of a kind: the registry first, then the cluster's own discovery (custom resources). */
export const resolveKind = async (target: Target, input: string, apiVersion?: string): Promise<KindInfo> => {
  if (apiVersion) {
    const known = findKindByApiVersion(apiVersion, input);
    if (known) return known;
    const slash = apiVersion.indexOf('/');
    const group = slash < 0 ? '' : apiVersion.slice(0, slash);
    const version = slash < 0 ? apiVersion : apiVersion.slice(slash + 1);
    const list = await callJson(target, { path: group ? `/apis/${apiVersion}` : `/api/${version}` });
    const found = fromResources(group, version, (list.resources ?? []) as Resource[]).find((info) => info.kind === input);
    if (!found) throw new K8sError('NOT_FOUND', `This cluster has no kind "${input}" in ${apiVersion}.`);
    return found;
  }
  const known = findKind(input);
  if (known) return known;
  const wanted = input.trim().toLowerCase();
  const dot = wanted.indexOf('.');
  const [word, group] = dot < 0 ? [wanted, null] : [wanted.slice(0, dot), wanted.slice(dot + 1)];
  const found = (await discoverAll(target)).find((info) => (group === null || info.group === group) && (info.kind.toLowerCase() === word || info.plural === word || info.aliases?.includes(word)));
  if (!found) throw new K8sError('NOT_FOUND', `This cluster has no kind "${clip(input, 60)}".`);
  return found;
};
