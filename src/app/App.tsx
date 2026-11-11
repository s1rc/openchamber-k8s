import type { HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DEFAULT_KIND, NAV } from '../shared/kinds.ts';
import type { ScopeResult } from '../shared/types.ts';
import { ErrorState, type ErrorInfo } from './errors.tsx';
import { Header, type ContextRow } from './Header.tsx';
import { call, host, notify } from './host.ts';
import { Empty, Select, Spinner } from './kit.tsx';
import { Nav } from './Nav.tsx';
import { ResourceView } from './ResourceView.tsx';
import type { Live } from './useWatch.ts';
import { onLock } from './watches.ts';

type Boot = { phase: 'loading' } | { phase: 'error'; error: ErrorInfo } | { phase: 'ready'; contexts: ContextRow[]; current: string | null; scope: ScopeResult | null };

interface Selection {
  context: string | null;
  /** `_all` for every namespace. */
  namespace: string;
  /** The user chose something; a reload of the cluster list must not replace it. */
  touched: boolean;
}

/** Page layout needs room for the nav, the table and the drawer. */
const PAGE_MIN_WIDTH = 720;

const useReady = (): HostReadyContext | null => {
  const [ctx, setCtx] = useState<HostReadyContext | null>(null);
  useEffect(
    () =>
      host.onReady((next) => {
        applyHostReady(next, document.documentElement);
        // A theme change arrives as a new snapshot; only a new surface or project needs a new render.
        setCtx((prev) => (prev && prev.surface === next.surface && prev.directory === next.directory ? prev : next));
      }),
    [],
  );
  return ctx;
};

const useWidth = (): number => {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
};

const initialSelection = (scope: ScopeResult | null, current: string | null): Selection => ({
  context: scope?.context ?? (scope && scope.candidates.length > 0 ? null : current),
  namespace: scope?.namespace ?? '_all',
  touched: false,
});

export const App = () => {
  const ctx = useReady();
  const width = useWidth();
  const dir = ctx?.directory ?? null;
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const [sel, setSel] = useState<Selection>({ context: null, namespace: '_all', touched: false });
  const [kind, setKind] = useState(DEFAULT_KIND);
  const [live, setLive] = useState<Live>('connecting');
  const layout: 'page' | 'rail' = ctx?.surface === 'page' && width >= PAGE_MIN_WIDTH ? 'page' : 'rail';

  const load = async (showSpinner: boolean, project: string | null): Promise<void> => {
    if (showSpinner) setBoot({ phase: 'loading' });
    const reply = await call('GET', '/contexts', { dir: project });
    if (!reply.ok) {
      setBoot({ phase: 'error', error: { code: String(reply.code ?? 'INTERNAL'), message: reply.error } });
      return;
    }
    const scope = (reply.scope ?? null) as ScopeResult | null;
    const current = (reply.current ?? null) as string | null;
    setBoot({ phase: 'ready', contexts: reply.contexts as ContextRow[], current, scope });
    setSel((prev) => (prev.touched ? prev : initialSelection(scope, current)));
  };

  useEffect(() => {
    if (!ctx) return;
    setSel({ context: null, namespace: '_all', touched: false });
    void load(true, dir);
  }, [ctx !== null, dir]);

  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState === 'visible' && ctx) void load(false, dir);
    };
    document.addEventListener('visibilitychange', again);
    const stop = onLock((message) => {
      setBoot((prev) =>
        prev.phase === 'ready'
          ? { ...prev, contexts: prev.contexts.map((row) => (row.name === message.context ? { ...row, protected: message.protected, locked: message.locked, unlockedUntil: message.unlockedUntil } : row)) }
          : prev,
      );
    });
    return () => {
      document.removeEventListener('visibilitychange', again);
      stop();
    };
  }, [ctx !== null, dir]);

  const remember = async (context: string, namespace: string): Promise<void> => {
    if (!dir) return;
    const reply = await call('POST', '/scope', { dir, context, namespace });
    if (!reply.ok) return notify('error', String(reply.error ?? 'Could not remember your choice.'));
    setBoot((prev) => (prev.phase === 'ready' ? { ...prev, scope: (reply.scope ?? null) as ScopeResult | null } : prev));
  };

  const pickContext = (name: string): void => {
    setSel({ context: name, namespace: '_all', touched: true });
    setLive('connecting');
    void remember(name, '_all');
  };

  const pickNamespace = (name: string): void => {
    if (!sel.context) return;
    setSel({ context: sel.context, namespace: name, touched: true });
    void remember(sel.context, name);
  };

  const sectionOptions = useMemo(() => NAV.flatMap((section) => section.items.map((item) => ({ id: item.kind, label: item.title, hint: section.title }))), []);

  if (!ctx || boot.phase === 'loading') return <div class="k8s-center k8s-fill"><Spinner label="Loading clusters" /></div>;
  if (boot.phase === 'error') return <ErrorState error={boot.error} context={null} onRetry={() => void load(true, dir)} />;

  const { contexts, scope } = boot;
  const known = sel.context ? contexts.some((row) => row.name === sel.context) : false;

  let main;
  if (contexts.length === 0) {
    main = <div class="k8s-pad"><Empty title="No clusters found" body="Add a cluster to your kubeconfig (usually ~/.kube/config), then open this panel again." /></div>;
  } else if (!sel.context) {
    const candidates = scope?.candidates ?? [];
    main = (
      <div class="k8s-pad">
        <Empty
          title="Choose a cluster"
          body={candidates.length > 0 ? `Several clusters fit this project: ${candidates.join(', ')}. Pick one above and the panel will remember it.` : 'Pick a cluster above to see its resources.'}
        />
      </div>
    );
  } else if (!known) {
    main = <ErrorState error={{ code: 'NO_CONTEXT', message: `${sel.context} is not in your kubeconfig.` }} context={sel.context} />;
  } else {
    const view = (
      <ResourceView
        key={`${sel.context}|${sel.namespace}|${kind}`}
        context={sel.context}
        namespace={sel.namespace}
        kind={kind}
        dir={dir}
        layout={layout}
        onLive={setLive}
        lead={layout === 'rail' ? <Select value={kind} options={sectionOptions} onChange={setKind} searchable searchPlaceholder="Search resources" /> : undefined}
      />
    );
    main = layout === 'page' ? <div class="k8s-body"><Nav kind={kind} onPick={setKind} /><div class="k8s-content">{view}</div></div> : view;
  }

  return (
    <div class={`k8s-app k8s-app--${layout}`}>
      <Header contexts={contexts} context={known ? sel.context : null} namespace={sel.namespace} dir={dir} scope={scope} live={live} layout={layout} onPickContext={pickContext} onPickNamespace={pickNamespace} />
      <div class="k8s-main">{main}</div>
    </div>
  );
};
