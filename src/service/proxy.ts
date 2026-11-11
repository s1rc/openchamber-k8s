import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Target } from '../shared/types.ts';
import { childEnv } from './bins.ts';
import { clip, fromOutput, K8sError } from './errors.ts';
import { kubeconfigArgs, kubectlPath, run } from './exec.ts';
import { sockDir } from './state.ts';

const IDLE_MS = 10 * 60 * 1000;
const START_MS = 20_000;

interface Proxy {
  key: string;
  child: ChildProcess;
  sock: string;
  pidFile: string;
  ready: Promise<void>;
  lastUsed: number;
  streams: number;
  output: string;
  exited: boolean;
}

const proxies = new Map<string, Proxy>();
let sweeper: ReturnType<typeof setInterval> | null = null;

export const targetKey = (target: Target): string => `${target.kubeconfig ?? ''}|${target.context}`;
const hashOf = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 12);

const sweep = (): void => {
  const now = Date.now();
  for (const proxy of proxies.values()) if (proxy.streams === 0 && now - proxy.lastUsed > IDLE_MS) stopProxy(proxy.key);
  if (proxies.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
};

const spawnProxy = (target: Target): Proxy => {
  const key = targetKey(target);
  const dir = sockDir();
  const id = hashOf(key);
  const sock = join(dir, `${id}.sock`);
  rmSync(sock, { force: true });
  const child = spawn(kubectlPath(), ['--context', target.context, ...kubeconfigArgs(target.kubeconfig), 'proxy', `--unix-socket=${sock}`], {
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pidFile = join(dir, `${id}.pid`);
  if (child.pid) writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  const proxy: Proxy = { key, child, sock, pidFile, ready: Promise.resolve(), lastUsed: Date.now(), streams: 0, output: '', exited: false };
  proxy.ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new K8sError('UNREACHABLE', 'The cluster connection did not start in time.')), START_MS);
    const onData = (chunk: Buffer): void => {
      proxy.output = (proxy.output + String(chunk)).slice(-4000);
      if (/Starting to serve/.test(proxy.output)) {
        clearTimeout(timer);
        resolve();
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
      reject(fromOutput(proxy.output, 'The cluster connection stopped.', target.context));
    });
  });
  proxy.ready.catch(() => undefined);
  child.on('exit', () => {
    proxy.exited = true;
    if (proxies.get(key) === proxy) proxies.delete(key);
    rmSync(sock, { force: true });
    rmSync(pidFile, { force: true });
  });
  proxies.set(key, proxy);
  if (!sweeper) {
    sweeper = setInterval(sweep, 60_000);
    sweeper.unref();
  }
  return proxy;
};

/** The socket of a running proxy for this cluster, started on first use. */
export const ensureProxy = async (target: Target): Promise<string> => {
  const key = targetKey(target);
  let proxy = proxies.get(key);
  if (!proxy || proxy.exited) proxy = spawnProxy(target);
  proxy.lastUsed = Date.now();
  await proxy.ready;
  return proxy.sock;
};

/** Output the proxy printed so far, for classifying a failed request. Never logged. */
export const proxyOutput = (target: Target): string => proxies.get(targetKey(target))?.output ?? '';

export const touchProxy = (target: Target): void => {
  const proxy = proxies.get(targetKey(target));
  if (proxy) proxy.lastUsed = Date.now();
};

export const trackStream = (target: Target, delta: 1 | -1): void => {
  const proxy = proxies.get(targetKey(target));
  if (!proxy) return;
  proxy.streams = Math.max(0, proxy.streams + delta);
  proxy.lastUsed = Date.now();
};

export const stopProxy = (key: string): void => {
  const proxy = proxies.get(key);
  if (!proxy) return;
  proxies.delete(key);
  proxy.exited = true;
  proxy.child.kill('SIGTERM');
  rmSync(proxy.sock, { force: true });
  rmSync(proxy.pidFile, { force: true });
};

export const stopAllProxies = (): void => {
  for (const key of [...proxies.keys()]) stopProxy(key);
};

export const proxyCount = (): number => proxies.size;

/** After a crash the old kubectl proxy processes can outlive the service: stop them and clear stale sockets. */
export const cleanupStaleProxies = async (): Promise<void> => {
  const dir = sockDir();
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (name.endsWith('.pid')) {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1) {
        const out = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 5000 });
        if (/kubectl/.test(out.stdout) && /\bproxy\b/.test(out.stdout)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // Already gone.
          }
        }
      }
    }
    if (name.endsWith('.pid') || name.endsWith('.sock')) rmSync(file, { force: true });
  }
};
