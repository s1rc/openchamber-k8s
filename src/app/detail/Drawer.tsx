import { useEffect, useState } from 'preact/hooks';
import { Dot } from '@openchamber-ext/shared-ui/preact';
import { podSpecOf, statusOf, type KindView } from '../../shared/kinds.ts';
import type { Obj } from '../../shared/types.ts';
import { Banner, Button, Tabs } from '../kit.tsx';
import { ConsoleView } from '../dock/ConsoleView.tsx';
import { LogView } from '../dock/LogView.tsx';
import { Actions } from './Actions.tsx';
import { EventsTab } from './EventsTab.tsx';
import { Overview } from './Overview.tsx';
import { Yaml } from './Yaml.tsx';

type TabId = 'overview' | 'yaml' | 'events' | 'logs' | 'console';

const LOG_KINDS = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job']);

interface Props {
  object: Obj;
  /** The resource disappeared from the cluster while it was open. `object` is the last copy. */
  gone: boolean;
  view: KindView;
  context: string;
  dir: string | null;
  /** The panel's namespace, `_all` for every namespace. */
  namespace: string;
  now: number;
  onClose: () => void;
  /** Rail layout: a Back button instead of Close. */
  rail: boolean;
  /** Page layout: logs and consoles open in the dock. */
  onOpenLogs?: (object: Obj) => void;
  onOpenConsole?: (object: Obj) => void;
}

const containersOf = (object: Obj): string[] => {
  const spec = podSpecOf(object);
  return Array.isArray(spec?.containers) ? (spec.containers as Obj[]).map((container) => String(container.name)) : [];
};

export const Drawer = ({ object, gone, view, context, dir, namespace, now, onClose, rail, onOpenLogs, onOpenConsole }: Props) => {
  const [tab, setTab] = useState<TabId>('overview');
  const [editing, setEditing] = useState(false);
  const uid = String(object.metadata?.uid ?? `${object.metadata?.namespace}/${object.metadata?.name}`);
  const kind = String(object.kind ?? '');
  const objectNamespace = String(object.metadata?.namespace ?? (namespace !== '_all' ? namespace : ''));
  const status = statusOf(view, object);
  const containers = containersOf(object);
  const supportsLogs = LOG_KINDS.has(kind);

  useEffect(() => {
    setTab('overview');
    setEditing(false);
  }, [uid]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !editing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const openLogs = (): void => {
    if (rail) setTab('logs');
    else onOpenLogs?.(object);
  };
  const openConsole = (): void => {
    if (rail) setTab('console');
    else onOpenConsole?.(object);
  };

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'yaml', label: 'YAML' },
    { id: 'events', label: 'Events' },
    ...(rail && supportsLogs ? [{ id: 'logs', label: 'Logs' }] : []),
    ...(rail && kind === 'Pod' ? [{ id: 'console', label: 'Console' }] : []),
  ];

  return (
    <aside class="k8s-drawer" aria-label={`${String(object.metadata?.name)} details`}>
      <div class="k8s-drawer-head">
        <Button label={rail ? 'Back' : 'Close'} size="xs" variant="ghost" onClick={onClose} />
        <div class="k8s-drawer-title">
          <span class="k8s-drawer-kind sui-muted sui-small">{kind}</span>
          <strong class="k8s-ellipsis" title={String(object.metadata?.name)}>{String(object.metadata?.name ?? '')}</strong>
        </div>
        {status ? (
          <span class="k8s-status sui-small">
            <Dot tone={status.tone} />
            <span class="k8s-ellipsis">{status.label}</span>
          </span>
        ) : null}
        {!gone ? (
          <Actions
            object={object}
            context={context}
            dir={dir}
            namespace={objectNamespace}
            onOpenLogs={openLogs}
            onOpenConsole={openConsole}
            onEdit={() => {
              setTab('yaml');
              setEditing(true);
            }}
          />
        ) : null}
      </div>
      {gone ? <div class="k8s-pad"><Banner tone="warning" title="This resource was deleted" body="You are looking at the last copy the panel saw." /></div> : null}
      <div class="k8s-drawer-tabs">
        <Tabs items={tabs} activeId={tab} onChange={(id) => {
          if (id !== 'yaml') setEditing(false);
          setTab(id as TabId);
        }} />
      </div>
      <div class={`k8s-drawer-body${tab === 'logs' || tab === 'console' ? ' k8s-drawer-body--fill' : ''}`}>
        {tab === 'overview' ? <Overview object={object} view={view} now={now} context={context} namespace={objectNamespace || 'default'} /> : null}
        {tab === 'yaml' ? (
          <Yaml object={object} context={context} dir={dir} namespace={objectNamespace} editing={editing} onEditing={(value) => setEditing(value)} />
        ) : null}
        {tab === 'events' ? <EventsTab context={context} dir={dir} object={object} now={now} /> : null}
        {tab === 'logs' ? (
          <LogView context={context} dir={dir} namespace={objectNamespace || 'default'} object={object} onClose={() => setTab('overview')} />
        ) : null}
        {tab === 'console' ? (
          <ConsoleView
            context={context}
            dir={dir}
            namespace={objectNamespace || 'default'}
            pod={String(object.metadata?.name ?? '')}
            containers={containers}
            onClose={() => setTab('overview')}
          />
        ) : null}
      </div>
    </aside>
  );
};
