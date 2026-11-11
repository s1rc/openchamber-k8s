import { useEffect, useState } from 'preact/hooks';
import type { Obj, ForwardView } from '../shared/types.ts';
import { call } from './host.ts';
import { onForwards } from './watches.ts';

/** Every forward the service runs, kept current from its `forwards` events. */
export const useForwards = (): { forwards: ForwardView[]; loading: boolean; error: string | null; refresh: () => void } => {
  const [forwards, setForwards] = useState<ForwardView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void call('GET', '/forwards').then((reply) => {
      if (cancelled) return;
      setLoading(false);
      if (reply.ok) {
        setForwards((reply.forwards ?? []) as ForwardView[]);
        setError(null);
      } else setError(String(reply.error ?? 'Could not list the port forwards.'));
    });
    const stop = onForwards((list) => {
      setForwards(list);
      setError(null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [tick]);

  return { forwards, loading, error, refresh: () => setTick((value) => value + 1) };
};

/** The ports a Pod or Service offers, for the port forward dialog. */
export const portsOf = (object: Obj): number[] => {
  if (object.kind === 'Service') {
    return [...new Set((Array.isArray(object.spec?.ports) ? (object.spec.ports as Obj[]) : []).map((port) => Number(port.port)).filter((port) => Number.isInteger(port) && port > 0))];
  }
  const spec = object.spec?.containers ? object.spec : object.spec?.template?.spec;
  const ports = (Array.isArray(spec?.containers) ? (spec.containers as Obj[]) : []).flatMap((container) => (Array.isArray(container.ports) ? (container.ports as Obj[]) : []));
  return [...new Set(ports.map((port) => Number(port.containerPort)).filter((port) => Number.isInteger(port) && port > 0))];
};
