import { useEffect, useState } from 'preact/hooks';
import type { AuthView, SignInPlan } from '../shared/eks.ts';
import { call } from './host.ts';
import { onTopic } from './watches.ts';

// One place that knows how each cluster signs in and how the sign-ins are going. The service starts and ends a sign-in
// and pushes `auth` events; the panel never polls. A view that failed with AUTH_EXPIRED retries when its login comes back.

const plans = new Map<string, SignInPlan>();
const attempts = new Map<string, AuthView>();
const watchers = new Set<() => void>();
const doneListeners = new Set<(view: AuthView) => void>();
const fired = new Set<string>();
// The project the frame was opened for: a sign-in reads the kubeconfig that project names.
let project: string | null = null;
let listening = false;

const changed = (): void => {
  for (const watcher of [...watchers]) watcher();
};

/** Takes a view from an event. A finished sign-in tells the views that wait for it, once. */
const take = (view: AuthView, announce: boolean): void => {
  const previous = attempts.get(view.key);
  if (previous && previous.id !== view.id && previous.startedAt > view.startedAt) return;
  attempts.set(view.key, view);
  changed();
  if (announce && view.state === 'done' && !fired.has(view.id)) {
    fired.add(view.id);
    for (const listener of [...doneListeners]) listener(view);
  }
};

const listen = (): void => {
  if (listening) return;
  listening = true;
  onTopic('auth', (data) => take(data as AuthView, true));
};

/** Called whenever the cluster list is read: what Sign in does for each context. */
export const setPlans = (rows: Array<{ name: string; signIn?: SignInPlan | null }>, dir: string | null): void => {
  project = dir;
  plans.clear();
  for (const row of rows) if (row.signIn) plans.set(row.name, row.signIn);
  changed();
};

export const planFor = (context: string | null): SignInPlan | null => (context ? (plans.get(context) ?? null) : null);

/** The newest sign-in that covers a context, or one for an AWS profile. */
export const attemptForContext = (context: string | null): AuthView | null => {
  if (!context) return null;
  let found: AuthView | null = null;
  for (const view of attempts.values()) if (view.contexts.includes(context) || view.context === context) if (!found || view.startedAt > found.startedAt) found = view;
  return found;
};

export const attemptForProfile = (profile: string): AuthView | null => attempts.get(`sso:${profile}`) ?? null;

/** Reads the running sign-ins once, for a panel that opened while one was going. Events do not replay. */
export const loadSignIns = async (): Promise<void> => {
  listen();
  const reply = await call('GET', '/auth/status');
  if (!reply.ok) return;
  for (const view of (reply.attempts ?? []) as AuthView[]) take(view, false);
};

export interface StartResult {
  ok: boolean;
  error?: string;
}

/** Starts a sign-in for a cluster or an AWS profile. Only called from a click. */
export const startSignIn = async (target: { context?: string; profile?: string }): Promise<StartResult> => {
  listen();
  const reply = await call('POST', '/auth/login', { ...target, dir: project });
  if (!reply.ok) return { ok: false, error: String(reply.error ?? 'Could not start the sign-in.') };
  take(reply.auth as AuthView, false);
  return { ok: true };
};

export const cancelSignIn = async (id: string): Promise<void> => {
  const reply = await call('POST', '/auth/cancel', { id });
  if (reply.ok && reply.auth) take(reply.auth as AuthView, false);
};

/** Runs `listener` when any sign-in finishes. Returns the function that stops it. */
export const onSignedIn = (listener: (view: AuthView) => void): (() => void) => {
  listen();
  doneListeners.add(listener);
  return () => {
    doneListeners.delete(listener);
  };
};

/** Re-renders the component whenever a plan or a sign-in changes. */
export const useSignInState = (): void => {
  const [, setTick] = useState(0);
  useEffect(() => {
    listen();
    const watcher = (): void => setTick((n) => n + 1);
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  }, []);
};

/**
 * Runs `retry` when a sign-in that covers this context finishes, while `active` is true. A view that failed with
 * AUTH_EXPIRED uses it, so it comes back without anyone reopening the panel.
 */
export const useRetryOnSignIn = (context: string | null, active: boolean, retry: (() => void) | undefined): void => {
  useEffect(() => {
    listen();
    if (!active || !context || !retry) return;
    const listener = (view: AuthView): void => {
      if (view.contexts.includes(context) || view.context === context) retry();
    };
    doneListeners.add(listener);
    return () => {
      doneListeners.delete(listener);
    };
  }, [context, active, retry]);
};
