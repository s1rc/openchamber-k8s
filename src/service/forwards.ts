import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForwardKind, ForwardStatus, ForwardView, Target } from '../shared/types.ts';
import { childEnv } from './bins.ts';
import { K8sError, clip, fromOutput } from './errors.ts';
import { kubeconfigArgs, kubectlPath, run } from './exec.ts';
import { readJson, sockDir, writeJson } from './state.ts';
import { publish } from './watch.ts';

// Port forwards outlive the panel (the service is keepRunning). They are written to forwards.json so a
// service restart puts them back. A dropped forward is started again at most 3 times.

const MAX_RESTARTS = 3;
const RESTART_MS = 1000;
const START_MS = 15_000;
const FILE = 'forwards.json';

export interface ForwardConfig {
  id: string;
  context: string;
  kubeconfig?: string;
  namespace: string;
  kind: ForwardKind;
  name: string;
  localPort: number;
  remotePort: number;
}

interface Forward extends ForwardConfig {
  status: ForwardStatus;
  restarts: number;
  error?: string;
  child: ChildProcess | null;
  ready: boolean;
  stopping: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pidFile: string;
}

const forwards = new Map<string, Forward>();

const targetOf = (config: ForwardConfig): Target => (config.kubeconfig ? { context: config.context, kubeconfig: config.kubeconfig } : { context: config.context });

const publicView = (forward: Forward): ForwardView => ({
  id: forward.id,
  context: forward.context,
  namespace: forward.namespace,
  kind: forward.kind,
  name: forward.name,
  localPort: forward.localPort,
  remotePort: forward.remotePort,
  status: forward.status,
  restarts: forward.restarts,
  ...(forward.error ? { error: forward.error } : {}),
  url: `http://localhost:${forward.localPort}`,
});

export const listForwards = (): ForwardView[] => [...forwards.values()].map(publicView);

const announce = (): void => publish('forwards', { forwards: listForwards() });

const configs = (): ForwardConfig[] =>
  [...forwards.values()].map((forward) => ({
    id: forward.id,
    context: forward.context,
    ...(forward.kubeconfig ? { kubeconfig: forward.kubeconfig } : {}),
    namespace: forward.namespace,
    kind: forward.kind,
    name: forward.name,
    localPort: forward.localPort,
    remotePort: forward.remotePort,
  }));

const save = (): void => {
  try {
    writeJson(FILE, configs());
  } catch {
    // A forward that runs is still useful when the state folder cannot be written.
  }
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('No free local port.'))));
    });
  });

const schedule = (forward: Forward): void => {
  if (forward.stopping || forward.retryTimer) return;
  if (forward.restarts >= MAX_RESTARTS) {
    forward.status = 'failed';
    forward.error = `The forward stopped ${MAX_RESTARTS + 1} times. Check that the pod or service is running.`;
    announce();
    save();
    return;
  }
  forward.restarts += 1;
  forward.retryTimer = setTimeout(() => {
    forward.retryTimer = null;
    start(forward);
  }, RESTART_MS);
};

const start = (forward: Forward): void => {
  if (forward.stopping) return;
  const args = ['--context', forward.context, ...kubeconfigArgs(forward.kubeconfig), '-n', forward.namespace, 'port-forward', `${forward.kind}/${forward.name}`, `${forward.localPort}:${forward.remotePort}`, '--address', '127.0.0.1'];
  const child = spawn(kubectlPath(), args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  forward.child = child;
  forward.status = 'starting';
  forward.error = undefined;
  forward.ready = false;
  let output = '';
  if (child.pid) {
    try {
      writeFileSync(forward.pidFile, String(child.pid), { mode: 0o600 });
    } catch {
      // The pid file only helps clean up after a crash.
    }
  }
  const timer = setTimeout(() => {
    if (!forward.ready && !forward.stopping) {
      forward.error = 'kubectl did not open the forward in time.';
      child.kill('SIGTERM');
    }
  }, START_MS);
  timer.unref();
  const onData = (chunk: Buffer): void => {
    output = (output + String(chunk)).slice(-2000);
    if (!forward.ready && /Forwarding from/.test(output)) {
      forward.ready = true;
      forward.status = 'live';
      forward.error = undefined;
      clearTimeout(timer);
      announce();
      save();
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (error) => {
    clearTimeout(timer);
    forward.error = clip(error.message);
    forward.child = null;
    schedule(forward);
  });
  child.on('exit', () => {
    clearTimeout(timer);
    const wasReady = forward.ready;
    forward.child = null;
    rmSync(forward.pidFile, { force: true });
    if (forward.stopping) return;
    forward.status = 'starting';
    forward.error = wasReady ? 'The forward stopped. It is starting again.' : fromOutput(output, 'The forward did not start.', forward.context).message;
    schedule(forward);
    announce();
  });
  announce();
};

export interface CreateInput {
  context: string;
  kubeconfig?: string;
  namespace: string;
  kind: ForwardKind;
  name: string;
  localPort?: number;
  remotePort: number;
}

/** Starts a forward and lists it in forwards.json. */
export const createForward = async (input: CreateInput): Promise<ForwardView> => {
  const localPort = input.localPort && input.localPort > 0 ? input.localPort : await freePort();
  const taken = [...forwards.values()].some((forward) => forward.localPort === localPort && forward.status !== 'stopped' && forward.status !== 'failed');
  if (taken) throw new K8sError('BAD_REQUEST', `Local port ${localPort} is already used by another forward.`);
  const id = `f_${createHash('sha1').update(`${input.context}|${input.namespace}|${input.kind}/${input.name}|${localPort}|${Date.now()}`).digest('hex').slice(0, 10)}`;
  const forward: Forward = {
    id,
    context: input.context,
    ...(input.kubeconfig ? { kubeconfig: input.kubeconfig } : {}),
    namespace: input.namespace,
    kind: input.kind,
    name: input.name,
    localPort,
    remotePort: input.remotePort,
    status: 'starting',
    restarts: 0,
    child: null,
    ready: false,
    stopping: false,
    retryTimer: null,
    pidFile: join(sockDir(), `fwd-${id}.pid`),
  };
  forwards.set(id, forward);
  start(forward);
  save();
  return publicView(forward);
};

export const stopForward = (id: string): void => {
  const forward = forwards.get(id);
  if (!forward) return;
  forward.stopping = true;
  forward.status = 'stopped';
  if (forward.retryTimer) clearTimeout(forward.retryTimer);
  forward.retryTimer = null;
  forward.child?.kill('SIGTERM');
  forward.child = null;
  rmSync(forward.pidFile, { force: true });
  forwards.delete(id);
  save();
  announce();
};

export const stopAllForwards = (): void => {
  for (const id of [...forwards.keys()]) stopForward(id);
};

/** On shutdown the children go, but forwards.json stays, so the next service start puts them back. */
export const shutdownForwards = (): void => {
  for (const forward of forwards.values()) {
    forward.stopping = true;
    if (forward.retryTimer) clearTimeout(forward.retryTimer);
    forward.retryTimer = null;
    forward.child?.kill('SIGTERM');
    forward.child = null;
    rmSync(forward.pidFile, { force: true });
  }
};

/** After a service restart, a kubectl port-forward from the old process can still hold the local port. */
const killStale = async (): Promise<void> => {
  const dir = sockDir();
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('fwd-') || !name.endsWith('.pid')) continue;
    const file = join(dir, name);
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) {
      const out = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 5000 });
      if (/kubectl/.test(out.stdout) && /port-forward/.test(out.stdout)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
    }
    rmSync(file, { force: true });
  }
};

/** Puts the forwards from forwards.json back. Called once when the service starts. */
export const restoreForwards = async (): Promise<void> => {
  await killStale().catch(() => undefined);
  const saved = readJson<ForwardConfig[]>(FILE, []);
  if (!Array.isArray(saved)) return;
  for (const config of saved) {
    if (!config || typeof config.id !== 'string' || typeof config.name !== 'string') continue;
    forwards.set(config.id, {
      ...config,
      status: 'starting',
      restarts: 0,
      child: null,
      ready: false,
      stopping: false,
      retryTimer: null,
      pidFile: join(sockDir(), `fwd-${config.id}.pid`),
    });
  }
  for (const forward of forwards.values()) start(forward);
};

export const forwardCount = (): number => forwards.size;
