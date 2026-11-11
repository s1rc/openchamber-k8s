import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cellText, findKind, rowText, sortRows, statusOf, viewFor, type KindInfo, type Tone, type ViewContext } from '../shared/kinds.ts';
import type { Obj } from '../shared/types.ts';
import { Drawer } from './detail/Drawer.tsx';
import { ErrorState } from './errors.tsx';
import { Empty, List, SearchField, Spinner } from './kit.tsx';
import { Table, type SortState } from './Table.tsx';
import { UsageBar } from './UsageBar.tsx';
import { useUsage } from './useUsage.ts';
import { useWatch, type Live } from './useWatch.ts';

interface Props {
  context: string;
  /** `_all` for every namespace. */
  namespace: string;
  kind: string;
  dir: string | null;
  layout: 'page' | 'rail';
  /** Rail layout: the section picker, drawn in the toolbar. */
  lead?: ComponentChildren;
  onLive: (live: Live) => void;
  /** Page layout: logs, consoles and port forwards open in the dock. */
  onOpenLogs?: (object: Obj) => void;
  onOpenConsole?: (object: Obj) => void;
}

const RAIL_MAX = 300;
const DRAWER_MIN = 320;
const DRAWER_MAX = 760;

const badgeTone = (tone: Tone): 'success' | 'warning' | 'error' | 'info' | 'neutral' => (tone === 'muted' ? 'neutral' : tone);

export const ResourceView = ({ context, namespace, kind, dir, layout, lead, onLive, onOpenLogs, onOpenConsole }: Props) => {
  const watch = useWatch({ context, namespace, kind, dir });
  // Nodes and pods show usage from metrics-server next to their numbers.
  const wantsUsage = kind === 'Node' || kind === 'Pod';
  const usageView = useUsage({ context, dir, namespace: kind === 'Pod' ? namespace : '_all', nodes: kind === 'Node', pods: kind === 'Pod', disk: kind === 'Node', enabled: wantsUsage });
  const ctx = useMemo<ViewContext | undefined>(() => (wantsUsage ? { usage: usageView.usage } : undefined), [wantsUsage, usageView.usage]);
  const fallback = findKind(kind);
  const info: Pick<KindInfo, 'kind' | 'group' | 'namespaced'> = watch.info ?? fallback ?? { kind, group: '', namespaced: true };
  const view = viewFor(info);
  const [sort, setSort] = useState<SortState>(view.sort);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(460);
  const last = useRef<Obj | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const now = Date.now();

  useEffect(() => onLive(watch.live), [watch.live]);

  const columns = useMemo(() => view.columns.filter((column) => column.id !== 'namespace' || (info.namespaced && namespace === '_all')), [view, info.namespaced, namespace]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle ? watch.items.filter((object) => rowText(view, object).includes(needle)) : watch.items;
    return sortRows(matching, view, sort.column, sort.dir, ctx);
  }, [watch.items, view, sort, query, ctx]);

  const onSort = (column: string): void => setSort((current) => (current.column === column ? { column, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' }));

  const live = selectedKey ? watch.map.get(selectedKey) : undefined;
  if (live) last.current = live;
  if (!selectedKey) last.current = null;
  const open = selectedKey ? (live ?? last.current) : null;
  const close = (): void => setSelectedKey(null);

  const startResize = (event: PointerEvent): void => {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      const right = host.current?.getBoundingClientRect().right ?? window.innerWidth;
      setDrawerWidth(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, Math.round(right - e.clientX))));
    };
    const stop = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
  };

  const where = namespace === '_all' ? 'any namespace' : `the ${namespace} namespace`;
  let body: ComponentChildren;
  if (watch.phase === 'loading') {
    body = <div class="k8s-center"><Spinner label={`Loading ${view.title.toLowerCase()}`} /></div>;
  } else if (watch.phase === 'error' && watch.error) {
    body = <ErrorState error={watch.error} context={context} onRetry={watch.reload} />;
  } else if (watch.items.length === 0) {
    body = <div class="k8s-pad"><Empty title={`No ${view.title.toLowerCase()}`} body={info.namespaced ? `There are none in ${where}.` : 'There are none in this cluster.'} /></div>;
  } else if (rows.length === 0) {
    body = <div class="k8s-pad"><Empty title="No matches" body={`Nothing matches "${query.trim()}".`} action={{ label: 'Clear search', onClick: () => setQuery('') }} /></div>;
  } else if (layout === 'page') {
    body = <Table view={view} columns={columns} rows={rows} sort={sort} onSort={onSort} selectedKey={selectedKey} onSelect={setSelectedKey} now={now} ctx={ctx} />;
  } else {
    const railColumn = view.columns.find((c) => c.id === (view.railColumn ?? 'age')) ?? view.columns[view.columns.length - 1]!;
    const showNamespace = info.namespaced && namespace === '_all';
    body = (
      <div class="k8s-rail-list">
        <List
          ariaLabel={view.title}
          selectedId={selectedKey}
          onSelect={setSelectedKey}
          items={rows.slice(0, RAIL_MAX).map((object) => {
            const status = statusOf(view, object);
            const meta = cellText(railColumn, object, now, ctx);
            return {
              id: `${object.metadata?.namespace ?? ''}/${object.metadata?.name ?? ''}`,
              title: view.railTitle?.(object) ?? String(object.metadata?.name ?? ''),
              subtitle: showNamespace ? String(object.metadata?.namespace ?? '') : undefined,
              meta: meta ? `${railColumn.label} ${meta}` : undefined,
              badge: status ? { label: status.label, tone: badgeTone(status.tone) } : undefined,
            };
          })}
        />
        {rows.length > RAIL_MAX ? <div class="k8s-pad sui-muted sui-small">{`Showing ${RAIL_MAX} of ${rows.length}. Search to narrow the list.`}</div> : null}
      </div>
    );
  }

  const count = watch.phase === 'ready' ? (query.trim() ? `${rows.length} of ${watch.items.length}` : String(watch.items.length)) : '';
  const drawer = open ? (
    <Drawer
      object={open}
      gone={Boolean(selectedKey) && !live}
      view={view}
      context={context}
      dir={dir}
      namespace={namespace}
      now={now}
      usage={wantsUsage ? usageView.usage : null}
      onClose={close}
      rail={layout === 'rail'}
      onOpenLogs={onOpenLogs}
      onOpenConsole={onOpenConsole}
    />
  ) : null;

  if (layout === 'rail') {
    if (drawer) return <div class="k8s-resource k8s-resource--rail">{drawer}</div>;
    return (
      <div class="k8s-resource k8s-resource--rail">
        <div class="k8s-toolbar k8s-toolbar--rail">
          {lead}
          <SearchField value={query} onChange={setQuery} placeholder={`Search ${view.title.toLowerCase()}`} />
          {count ? <span class="sui-muted sui-small">{`${count} ${view.title.toLowerCase()}`}</span> : null}
          {wantsUsage && watch.phase === 'ready' ? <UsageBar view={usageView} /> : null}
        </div>
        <div class="k8s-scroll">{body}</div>
      </div>
    );
  }

  return (
    <div class="k8s-resource" ref={host}>
      <div class="k8s-resource-main">
        <div class="k8s-toolbar">
          <h2 class="k8s-title">{view.title}</h2>
          {count ? <span class="sui-muted sui-small">{count}</span> : null}
          {wantsUsage && watch.phase === 'ready' ? <UsageBar view={usageView} /> : null}
          <span class="k8s-push k8s-search"><SearchField value={query} onChange={setQuery} placeholder={`Search ${view.title.toLowerCase()}`} /></span>
        </div>
        <div class="k8s-scroll k8s-scroll--table">{body}</div>
      </div>
      {drawer ? (
        <>
          <div class="k8s-resizer" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
          <div class="k8s-drawer-wrap" style={{ width: `${drawerWidth}px` }}>{drawer}</div>
        </>
      ) : null}
    </div>
  );
};
