import type { ComponentChildren } from 'preact';
import { useEffect, useMemo } from 'preact/hooks';
import { Cards, Section, StatCard } from '@openchamber-ext/shared-ui/preact';
import { summarize, warningEvents } from '../../shared/overview.ts';
import type { Obj } from '../../shared/types.ts';
import { useWatch, type Live, type WatchView } from '../useWatch.ts';
import { blockingError, combineLive, isForbidden, OverviewError, OverviewFrame, OverviewLoading, WarningList } from './shared.tsx';

interface Props {
  context: string;
  /** `_all` for every namespace. */
  namespace: string;
  dir: string | null;
  layout: 'page' | 'rail';
  lead?: ComponentChildren;
  onLive: (live: Live) => void;
  onNavigate: (kind: string) => void;
}

const loading = (view: WatchView): boolean => view.phase === 'loading' && view.items.length === 0;

const Card = ({ label, kind, view, onNavigate }: { label: string; kind: string; view: WatchView; onNavigate: (kind: string) => void }) => {
  const summary = useMemo(() => summarize(kind, view.items as Obj[]), [kind, view.items]);
  if (isForbidden(view)) return <StatCard label={label} value="-" breakdown={[{ tone: 'muted', text: 'no access' }]} />;
  if (loading(view)) return <StatCard label={label} value="..." />;
  return <StatCard label={label} value={summary.total} breakdown={summary.parts.length > 0 ? summary.parts.map((part) => ({ tone: part.tone, text: part.text })) : [{ tone: 'muted', text: 'none' }]} onClick={() => onNavigate(kind)} />;
};

/** Pods and the controllers that run them, counted by how healthy they look, plus the namespace's warnings. */
export const WorkloadsOverview = ({ context, namespace, dir, layout, lead, onLive, onNavigate }: Props) => {
  const pods = useWatch({ context, namespace, kind: 'Pod', dir });
  const deployments = useWatch({ context, namespace, kind: 'Deployment', dir });
  const daemonSets = useWatch({ context, namespace, kind: 'DaemonSet', dir });
  const statefulSets = useWatch({ context, namespace, kind: 'StatefulSet', dir });
  const replicaSets = useWatch({ context, namespace, kind: 'ReplicaSet', dir });
  const jobs = useWatch({ context, namespace, kind: 'Job', dir });
  const cronJobs = useWatch({ context, namespace, kind: 'CronJob', dir });
  const events = useWatch({ context, namespace, kind: 'Event', dir, fieldSelector: 'type=Warning' });
  const all = [pods, deployments, daemonSets, statefulSets, replicaSets, jobs, cronJobs, events];
  const live = combineLive(all.map((view) => view.live));
  useEffect(() => onLive(live), [live]);

  const warnings = useMemo(() => warningEvents(events.items, 8), [events.items]);
  const warningTotal = useMemo(() => events.items.filter((event) => event.type === 'Warning').length, [events.items]);
  const where = namespace === '_all' ? 'All namespaces' : `Namespace ${namespace}`;

  const blocked = blockingError(all);
  if (blocked) return <OverviewFrame title="Workloads overview" layout={layout} lead={lead} note={where}><OverviewError error={blocked} context={context} onRetry={() => all.forEach((view) => view.reload())} /></OverviewFrame>;
  if (loading(pods) && loading(deployments)) return <OverviewFrame title="Workloads overview" layout={layout} lead={lead} note={where}><OverviewLoading label="Loading workloads" /></OverviewFrame>;

  return (
    <OverviewFrame title="Workloads overview" layout={layout} lead={lead} note={where}>
      <Cards>
        <Card label="Pods" kind="Pod" view={pods} onNavigate={onNavigate} />
        <Card label="Deployments" kind="Deployment" view={deployments} onNavigate={onNavigate} />
        <Card label="DaemonSets" kind="DaemonSet" view={daemonSets} onNavigate={onNavigate} />
        <Card label="StatefulSets" kind="StatefulSet" view={statefulSets} onNavigate={onNavigate} />
        <Card label="ReplicaSets" kind="ReplicaSet" view={replicaSets} onNavigate={onNavigate} />
        <Card label="Jobs" kind="Job" view={jobs} onNavigate={onNavigate} />
        <Card label="CronJobs" kind="CronJob" view={cronJobs} onNavigate={onNavigate} />
      </Cards>
      <Section title="Warning events">
        <WarningList events={warnings} total={warningTotal} now={Date.now()} loading={loading(events)} onAll={() => onNavigate('Event')} />
      </Section>
    </OverviewFrame>
  );
};
