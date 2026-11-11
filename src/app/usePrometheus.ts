import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChartData } from './charts/Chart.tsx';
import type { ErrorInfo } from './errors.tsx';
import { call } from './host.ts';

// Prometheus is asked about when a view opens and when the user presses Refresh or saves a service. Never on a timer.

export interface PromStatus {
  found: boolean;
  namespace?: string;
  service?: string;
  port?: string;
  via?: 'proxy' | 'forward';
  source?: 'detected' | 'override';
  reason?: 'none' | 'forbidden' | 'unreachable';
  tried?: string[];
}

export interface PromStatusView {
  phase: 'loading' | 'ready' | 'error';
  status: PromStatus | null;
  error: ErrorInfo | null;
  reload: () => void;
  /** Use an answer from the Choose service dialog without asking again. */
  set: (status: PromStatus) => void;
}

export const usePromStatus = (context: string, dir: string | null, enabled = true): PromStatusView => {
  const [state, setState] = useState<{ phase: PromStatusView['phase']; status: PromStatus | null; error: ErrorInfo | null }>({ phase: 'loading', status: null, error: null });
  const load = useRef<(force: boolean) => void>(() => undefined);

  useEffect(() => {
    setState({ phase: 'loading', status: null, error: null });
    if (!enabled) return;
    let cancelled = false;
    let latest = 0;
    const read = async (force: boolean): Promise<void> => {
      const mine = ++latest;
      setState((prev) => ({ ...prev, phase: 'loading' }));
      const reply = await call('GET', '/prometheus', { context, dir, refresh: force ? '1' : undefined });
      if (cancelled || mine !== latest) return;
      if (!reply.ok) setState({ phase: 'error', status: null, error: { code: String(reply.code ?? 'INTERNAL'), message: reply.error } });
      else setState({ phase: 'ready', status: reply as unknown as PromStatus, error: null });
    };
    load.current = (force) => void read(force);
    void read(false);
    return () => {
      cancelled = true;
    };
  }, [context, dir, enabled]);

  return { ...state, reload: () => load.current(true), set: (status) => setState({ phase: 'ready', status, error: null }) };
};

export interface ChartRequest {
  context: string;
  dir: string | null;
  scope: 'pod' | 'workload' | 'node';
  kind?: string;
  namespace?: string;
  name: string;
  addresses?: string[];
}

export interface ChartsReply {
  available: boolean;
  reason?: 'none' | 'forbidden' | 'unreachable';
  via?: 'proxy' | 'forward';
  service?: string;
  start: number;
  end: number;
  step: number;
  charts: ChartData[];
}

export interface ChartsView {
  phase: 'loading' | 'ready' | 'error';
  reply: ChartsReply | null;
  error: ErrorInfo | null;
  reload: () => void;
}

export const useCharts = (request: ChartRequest, enabled = true): ChartsView => {
  const [state, setState] = useState<{ phase: ChartsView['phase']; reply: ChartsReply | null; error: ErrorInfo | null }>({ phase: 'loading', reply: null, error: null });
  const load = useRef<() => void>(() => undefined);
  const key = `${request.context}|${request.dir ?? ''}|${request.scope}|${request.kind ?? ''}|${request.namespace ?? ''}|${request.name}|${(request.addresses ?? []).join(',')}|${enabled}`;

  useEffect(() => {
    setState({ phase: 'loading', reply: null, error: null });
    if (!enabled) return;
    let cancelled = false;
    let latest = 0;
    const read = async (): Promise<void> => {
      const mine = ++latest;
      setState((prev) => ({ ...prev, phase: 'loading' }));
      const reply = await call('POST', '/prometheus/charts', {
        context: request.context,
        dir: request.dir,
        scope: request.scope,
        kind: request.kind,
        namespace: request.namespace,
        name: request.name,
        addresses: request.addresses,
      });
      if (cancelled || mine !== latest) return;
      if (!reply.ok) setState({ phase: 'error', reply: null, error: { code: String(reply.code ?? 'INTERNAL'), message: reply.error } });
      else setState({ phase: 'ready', reply: reply as unknown as ChartsReply, error: null });
    };
    load.current = () => void read();
    void read();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { ...state, reload: () => load.current() };
};
