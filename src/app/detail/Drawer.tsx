import { useEffect, useState } from 'preact/hooks';
import { Dot } from '@openchamber-ext/shared-ui/preact';
import { statusOf, type KindView } from '../../shared/kinds.ts';
import type { Obj } from '../../shared/types.ts';
import { Banner, Button, Tabs } from '../kit.tsx';
import { EventsTab } from './EventsTab.tsx';
import { Overview } from './Overview.tsx';
import { Yaml } from './Yaml.tsx';

type TabId = 'overview' | 'yaml' | 'events';

interface Props {
  object: Obj;
  /** The resource disappeared from the cluster while it was open. `object` is the last copy. */
  gone: boolean;
  view: KindView;
  context: string;
  dir: string | null;
  now: number;
  onClose: () => void;
  /** Rail layout: a Back button instead of Close. */
  rail: boolean;
}

export const Drawer = ({ object, gone, view, context, dir, now, onClose, rail }: Props) => {
  const [tab, setTab] = useState<TabId>('overview');
  const uid = String(object.metadata?.uid ?? `${object.metadata?.namespace}/${object.metadata?.name}`);
  useEffect(() => setTab('overview'), [uid]);
  const status = statusOf(view, object);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside class="k8s-drawer" aria-label={`${String(object.metadata?.name)} details`}>
      <div class="k8s-drawer-head">
        <Button label={rail ? 'Back' : 'Close'} size="xs" variant="ghost" onClick={onClose} />
        <div class="k8s-drawer-title">
          <span class="k8s-drawer-kind sui-muted sui-small">{String(object.kind ?? '')}</span>
          <strong class="k8s-ellipsis" title={String(object.metadata?.name)}>{String(object.metadata?.name ?? '')}</strong>
        </div>
        {status ? (
          <span class="k8s-status sui-small">
            <Dot tone={status.tone} />
            <span class="k8s-ellipsis">{status.label}</span>
          </span>
        ) : null}
      </div>
      {gone ? <div class="k8s-pad"><Banner tone="warning" title="This resource was deleted" body="You are looking at the last copy the panel saw." /></div> : null}
      <div class="k8s-drawer-tabs">
        <Tabs
          items={[
            { id: 'overview', label: 'Overview' },
            { id: 'yaml', label: 'YAML' },
            { id: 'events', label: 'Events' },
          ]}
          activeId={tab}
          onChange={(id) => setTab(id as TabId)}
        />
      </div>
      <div class="k8s-drawer-body">
        {tab === 'overview' ? <Overview object={object} view={view} now={now} /> : null}
        {tab === 'yaml' ? <Yaml object={object} /> : null}
        {tab === 'events' ? <EventsTab context={context} dir={dir} object={object} now={now} /> : null}
      </div>
    </aside>
  );
};
