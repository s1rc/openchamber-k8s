import { useEffect, useRef, useState } from 'preact/hooks';
import type { CrdEntry } from '../shared/crds.ts';
import { call } from './host.ts';
import { useRetryOnSignIn } from './signin.ts';

export interface CrdsView {
  /** Null until the first answer. An empty list when the cluster has no custom resources, or the read failed. */
  crds: CrdEntry[] | null;
  /** The cluster's definitions could not be read (no permission, not reachable). The fixed navigation still works. */
  failed: boolean;
  /** Reads again, for a CRD installed or removed since. */
  reload: () => void;
}

/**
 * The cluster's custom resource definitions, for the navigation and the custom resource tables. Read when a cluster is
 * opened and on `reload` (when Definitions opens); nothing here polls.
 */
export const useCrds = (context: string | null, dir: string | null): CrdsView => {
  const [state, setState] = useState<{ crds: CrdEntry[] | null; failed: boolean; auth: boolean }>({ crds: null, failed: false, auth: false });
  const readRef = useRef<(refresh: boolean) => void>(() => undefined);

  useEffect(() => {
    setState({ crds: null, failed: false, auth: false });
    if (!context) {
      readRef.current = () => undefined;
      return;
    }
    let cancelled = false;
    let latest = 0;
    const read = (refresh: boolean): void => {
      const mine = ++latest;
      void call('GET', '/crds', { context, dir, refresh: refresh ? '1' : undefined }).then((reply) => {
        if (cancelled || mine !== latest) return;
        if (reply.ok) setState({ crds: (reply.crds ?? []) as CrdEntry[], failed: false, auth: false });
        else setState((prev) => ({ crds: prev.crds ?? [], failed: true, auth: reply.code === 'AUTH_EXPIRED' }));
      });
    };
    readRef.current = read;
    read(false);
    return () => {
      cancelled = true;
    };
  }, [context, dir]);

  // The navigation has no banner to carry the sign-in, so the list is read again when one finishes.
  useRetryOnSignIn(context, state.auth, () => readRef.current(false));
  return { crds: state.crds, failed: state.failed, reload: () => readRef.current(true) };
};
