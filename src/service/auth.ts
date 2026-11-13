import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { signInUrl, type AuthState, type AuthView } from '../shared/eks.ts';
import { childEnv } from './bins.ts';
import { classifyText, clip, scrub } from './errors.ts';

/** How long a sign-in may wait for the user in the browser before it is stopped. */
export type { AuthState, AuthView };

export const SIGN_IN_MS = 5 * 60 * 1000;
/** A finished sign-in is remembered this long, so a panel that opens late can still say how it went. */
const KEEP_MS = 10 * 60 * 1000;

export interface SignInRequest {
  kind: 'sso' | 'oidc';
  /** One sign-in per key at a time: `sso:<profile>` or `oidc:<login>`. */
  key: string;
  profile?: string;
  context?: string;
  contexts: string[];
  file: string;
  args: string[];
}

export interface AuthDeps {
  now: () => number;
  timeoutMs: number;
  announce: (view: AuthView) => void;
  /** Called once when a sign-in succeeded. */
  onDone: (view: AuthView) => void;
}

interface Attempt {
  view: AuthView;
  child: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  stop: 'cancelled' | 'timeout' | null;
  output: string;
  /** Only what the program printed as an error: it holds the reason when a sign-in fails. */
  errors: string;
}

const stopTree = (child: ChildProcess): void => {
  if (!child.pid) return;
  try {
    // The sign-in program starts helpers of its own (kubelogin, the local page that waits for the browser): stop the whole group.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
};

/**
 * Decides how a sign-in ended. `aws sso login` exits 0 when the login finished. For `kubectl get ns` (which makes
 * kubelogin open the browser) a Forbidden answer also counts: the login worked, the account just may not list namespaces.
 */
export const outcomeOf = (kind: 'sso' | 'oidc', code: number, output: string): { ok: true } | { ok: false; error: string } => {
  if (code === 0) return { ok: true };
  if (kind === 'oidc' && /forbidden/i.test(output) && classifyText(output) !== 'AUTH_EXPIRED') return { ok: true };
  const found = classifyText(output);
  if (kind === 'oidc' && found === 'AUTH_EXPIRED') return { ok: false, error: 'The sign-in did not finish. Try again.' };
  if (found === 'UNREACHABLE') return { ok: false, error: 'The cluster is not reachable. Check your network or VPN.' };
  if (found === 'NO_KUBECTL') return { ok: false, error: 'A program the sign-in needs was not found. Install it and try again.' };
  // The programs print a long greeting first; the reason is in the last lines.
  const tail = output.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-2).join(' ');
  return { ok: false, error: clip(scrub(tail), 200) || 'The sign-in did not finish. Try again.' };
};

export const createAuth = (deps: AuthDeps) => {
  const attempts = new Map<string, Attempt>();
  const byId = new Map<string, Attempt>();

  const prune = (): void => {
    const now = deps.now();
    for (const [key, attempt] of attempts) {
      if (attempt.view.state !== 'running' && now - attempt.view.expiresAt > KEEP_MS) {
        attempts.delete(key);
        byId.delete(attempt.view.id);
      }
    }
  };

  const finish = (attempt: Attempt, state: AuthState, error?: string): void => {
    if (attempt.view.state !== 'running') return;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    attempt.view = { ...attempt.view, state, expiresAt: deps.now(), ...(error ? { error } : {}) };
    delete attempt.view.joined;
    deps.announce(attempt.view);
    if (state === 'done') deps.onDone(attempt.view);
  };

  const start = (request: SignInRequest): AuthView => {
    prune();
    const running = attempts.get(request.key);
    if (running && running.view.state === 'running') return { ...running.view, joined: true };
    const now = deps.now();
    const view: AuthView = {
      id: `a_${randomBytes(6).toString('hex')}`,
      key: request.key,
      kind: request.kind,
      profile: request.profile ?? null,
      context: request.context ?? null,
      contexts: request.contexts,
      state: 'running',
      startedAt: now,
      expiresAt: now + deps.timeoutMs,
    };
    const attempt: Attempt = { view, child: null, timer: null, stop: null, output: '', errors: '' };
    if (running) byId.delete(running.view.id);
    attempts.set(request.key, attempt);
    byId.set(view.id, attempt);
    const child = spawn(request.file, request.args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    attempt.child = child;
    const onData = (chunk: Buffer): void => {
      attempt.output = (attempt.output + String(chunk)).slice(-6000);
      if (request.kind === 'sso' && !attempt.view.url) {
        const url = signInUrl(attempt.output);
        if (url) {
          attempt.view = { ...attempt.view, url };
          deps.announce(attempt.view);
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => {
      attempt.errors = (attempt.errors + String(chunk)).slice(-4000);
      onData(chunk);
    });
    child.on('error', () => finish(attempt, 'failed', 'A program the sign-in needs was not found. Install it and try again.'));
    child.on('exit', (code) => {
      if (attempt.stop === 'cancelled') return finish(attempt, 'cancelled');
      if (attempt.stop === 'timeout') return finish(attempt, 'timeout', `The sign-in was not finished in ${Math.round(deps.timeoutMs / 60_000)} minutes.`);
      const result = outcomeOf(request.kind, code ?? -1, attempt.errors.trim() ? attempt.errors : attempt.output);
      if (result.ok) finish(attempt, 'done');
      else finish(attempt, 'failed', result.error);
    });
    attempt.timer = setTimeout(() => {
      attempt.stop = 'timeout';
      stopTree(child);
      // A program that ignores SIGTERM must not keep the sign-in running for ever.
      setTimeout(() => finish(attempt, 'timeout', `The sign-in was not finished in ${Math.round(deps.timeoutMs / 60_000)} minutes.`), 3000).unref();
    }, deps.timeoutMs);
    attempt.timer.unref();
    deps.announce(attempt.view);
    return attempt.view;
  };

  const cancel = (id: string): AuthView | null => {
    const attempt = byId.get(id);
    if (!attempt) return null;
    if (attempt.view.state === 'running' && attempt.child) {
      attempt.stop = 'cancelled';
      stopTree(attempt.child);
      // The panel should not wait for the program to exit.
      finish(attempt, 'cancelled');
    }
    return attempt.view;
  };

  const list = (): AuthView[] => {
    prune();
    return [...attempts.values()].map((attempt) => attempt.view);
  };

  const stopAll = (): void => {
    for (const attempt of attempts.values()) {
      if (attempt.view.state === 'running' && attempt.child) {
        attempt.stop = 'cancelled';
        stopTree(attempt.child);
      }
    }
  };

  return { start, cancel, list, stopAll };
};
