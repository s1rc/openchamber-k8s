import { useEffect, useRef, useState } from 'preact/hooks';
import type { ErrorInfo } from '../errors.tsx';
import { call } from '../host.ts';

export type Read<T> = { phase: 'loading' } | { phase: 'ready'; data: T } | { phase: 'error'; error: ErrorInfo };

/**
 * One read from the service, made when the inputs change and again on `reload`. Used by the Helm tabs: a tab reads when
 * it opens and when the user asks, never on a timer.
 */
export const useRead = <T>(path: string, params: Record<string, string | null | undefined>, pick: (reply: Record<string, unknown>) => T): [Read<T>, () => void] => {
  const [state, setState] = useState<Read<T>>({ phase: 'loading' });
  const [tick, setTick] = useState(0);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const key = `${path}|${JSON.stringify(params)}|${tick}`;

  useEffect(() => {
    let cancelled = false;
    setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    void call('GET', path, params).then((reply) => {
      if (cancelled) return;
      if (reply.ok) setState({ phase: 'ready', data: pickRef.current(reply as Record<string, unknown>) });
      else setState({ phase: 'error', error: { code: String(reply.code ?? 'INTERNAL'), message: reply.error } });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return [state, () => setTick((n) => n + 1)];
};
