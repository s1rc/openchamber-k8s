import type { HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DEFAULT_KIND, NAV } from '../shared/kinds.ts';
import type { Obj, ScopeResult } from '../shared/types.ts';
import { ActivityView } from './ActivityView.tsx';
import { Dock, type DockTab } from './dock/Dock.tsx';
import { ErrorState, type ErrorInfo } from './errors.tsx';
import { ForwardsSection } from './ForwardsSection.tsx';
import { Header, type ContextRow } from './Header.tsx';
import { call, host, notify } from './host.ts';
import { Button, Empty, Select, Spinner } from './kit.tsx';
import { LockBanner } from './LockBanner.tsx';
import { Modal } from './Modal.tsx';
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
const FORWARDS_TAB: DockTab = { id: 'forwards', kind: 'forwards', title: 'Port forwarding' };

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

const tabTitleFor = (object: Obj): string => `${String(object.kind ?? '')}/${String(object.metadata?.name ?? '')}`;

export const App = () => {
  const ctx = useReady();
  const width = useWidth();
  const dir = ctx?.directory ?? null;
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const [sel, setSel] = useState<Selection>({ context: null, namespace: '_all', touched: false });
  const [kind, setKind] = useState(DEFAULT_KIND);
  const [live, setLive] = useState<Live>('connecting');
  const [dockTabs, setDockTabs] = useState<DockTab[]>([FORWARDS_TAB]);
  const [dockActive, setDockActive] = useState<string | null>(FORWARDS_TAB.id);
  const [unlockFor, setUnlockFor] = useState<string | null>(null);
  const [activity, setActivity] = useState(false);
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

  const updateContext = (name: string, change: Partial<ContextRow>): void => {
    setBoot((prev) => (prev.phase === 'ready' ? { ...prev, contexts: prev.contexts.map((row) => (row.name === name ? { ...row, ...change } : row)) } : prev));
  };

  const pickContext = (name: string): void => {
    setSel({ context: name, namespace: '_all', touched: true });
    setLive('connecting');
    setDockTabs([FORWARDS_TAB]);
    setDockActive(FORWARDS_TAB.id);
    void remember(name, '_all');
  };

  const pickNamespace = (name: string): void => {
    if (!sel.context) return;
    setSel({ context: sel.context, namespace: name, touched: true });
    void remember(sel.context, name);
  };

  const unlock = async (name: string): Promise<void> => {
    setUnlockFor(null);
    const reply = await call('POST', '/unlock', { context: name, dir });
    if (!reply.ok) return notify('error', String(reply.error ?? 'Could not unlock the cluster.'));
    const until = typeof reply.unlockedUntil === 'number' ? reply.unlockedUntil : Date.now() + 30 * 60 * 1000;
    updateContext(name, { locked: false, unlockedUntil: until });
    notify('success', `${name} is unlocked for 30 minutes.`);
  };

  const lockNow = async (name: string): Promise<void> => {
    const reply = await call('POST', '/lock', { context: name, dir });
    if (!reply.ok) return notify('error', String(reply.error ?? 'Could not lock the cluster.'));
    updateContext(name, { locked: true, unlockedUntil: null });
    notify('success', `${name} is locked.`);
  };

  const openLogs = (object: Obj): void => {
    const namespace = String(object.metadata?.namespace ?? (sel.namespace !== '_all' ? sel.namespace : 'default'));
    const id = `logs:${String(object.metadata?.uid ?? `${namespace}/${object.metadata?.name}`)}`;
    setDockTabs((prev) => (prev.some((tab) => tab.id === id) ? prev : [...prev, { id, kind: 'logs', title: `Logs ${tabTitleFor(object)}`, object, namespace }]));
    setDockActive(id);
  };

  const openConsole = (object: Obj): void => {
    const namespace = String(object.metadata?.namespace ?? (sel.namespace !== '_all' ? sel.namespace : 'default'));
    const id = `console:${namespace}/${String(object.metadata?.name ?? '')}`;
    const containers = Array.isArray(object.spec?.containers) ? (object.spec.containers as Obj[]).map((container) => String(container.name)) : [];
    setDockTabs((prev) => (prev.some((tab) => tab.id === id) ? prev : [...prev, { id, kind: 'console', title: `Console ${String(object.metadata?.name ?? '')}`, pod: String(object.metadata?.name ?? ''), containers, namespace }]));
    setDockActive(id);
  };

  const closeTab = (id: string): void => {
    setDockTabs((prev) => prev.filter((tab) => tab.id !== id));
    setDockActive((current) => (current === id ? null : current));
  };

  const sectionOptions = useMemo(() => NAV.flatMap((section) => section.items.map((item) => ({ id: item.kind, label: item.title, hint: section.title }))), []);

  if (!ctx || boot.phase === 'loading') return <div class="k8s-center k8s-fill"><Spinner label="Loading clusters" /></div>;
  if (boot.phase === 'error') return <ErrorState error={boot.error} context={null} onRetry={() => void load(true, dir)} />;

  const { contexts, scope } = boot;
  const known = sel.context ? contexts.some((row) => row.name === sel.context) : false;
  const currentRow = contexts.find((row) => row.name === sel.context) ?? null;

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
  } else if (kind === 'PortForwards') {
    main = <ForwardsSection context={sel.context} />;
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
        onOpenLogs={openLogs}
        onOpenConsole={openConsole}
        lead={layout === 'rail' ? <Select value={kind} options={sectionOptions} onChange={setKind} searchable searchPlaceholder="Search resources" /> : undefined}
      />
    );
    main = layout === 'page' ? <div class="k8s-body"><Nav kind={kind} onPick={setKind} /><div class="k8s-content">{view}</div></div> : view;
  }

  return (
    <div class={`k8s-app k8s-app--${layout}`}>
      <Header
        contexts={contexts}
        context={known ? sel.context : null}
        namespace={sel.namespace}
        dir={dir}
        scope={scope}
        live={live}
        layout={layout}
        onPickContext={pickContext}
        onPickNamespace={pickNamespace}
        onUnlock={(name) => setUnlockFor(name)}
        onLockNow={(name) => void lockNow(name)}
        onActivity={() => setActivity(true)}
      />
      {currentRow?.protected && !currentRow.locked && currentRow.unlockedUntil && currentRow.unlockedUntil > Date.now() ? (
        <LockBanner
          context={currentRow.name}
          until={currentRow.unlockedUntil}
          onLock={() => void lockNow(currentRow.name)}
          onExpired={() => updateContext(currentRow.name, { locked: true, unlockedUntil: null })}
        />
      ) : null}
      <div class="k8s-main">
        {main}
        {layout === 'page' && known ? (
          <Dock tabs={dockTabs} active={dockActive} context={sel.context} dir={dir} onPick={setDockActive} onClose={closeTab} />
        ) : null}
      </div>
      {unlockFor ? (
        <Modal
          title={`Unlock ${unlockFor}?`}
          onClose={() => setUnlockFor(null)}
          footer={
            <>
              <Button label="Unlock for 30 minutes" size="sm" variant="destructive" onClick={() => void unlock(unlockFor)} />
              <Button label="Cancel" size="sm" variant="ghost" onClick={() => setUnlockFor(null)} />
            </>
          }
        >
          <div class="k8s-wrap">{`${unlockFor} is a production cluster. Unlocking allows writes from this panel and from the agent for 30 minutes, then it locks again. Lock it yourself with Lock now when you are done.`}</div>
        </Modal>
      ) : null}
      {activity && sel.context ? <ActivityView context={sel.context} dir={dir} onClose={() => setActivity(false)} /> : null}
    </div>
  );
};
