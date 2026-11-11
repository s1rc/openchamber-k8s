import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Cards, Dot, KV, Section, StatCard } from '@openchamber-ext/shared-ui/preact';
import { bytesText, coresText } from '../../shared/format.ts';
import { usageNote } from '../../shared/metrics.ts';
import { barTone, clusterTotals, fractionOf, summarize, warningEvents, type Resource } from '../../shared/overview.ts';
import { promMissingText } from '../charts/PromCharts.tsx';
import { PromServiceDialog } from '../charts/PromService.tsx';
import { Button, Progress, Spinner } from '../kit.tsx';
import { useUsage } from '../useUsage.ts';
import { usePromStatus } from '../usePrometheus.ts';
import { useWatch, type Live } from '../useWatch.ts';
import { blockingError, combineLive, isForbidden, NoAccess, OverviewError, OverviewFrame, OverviewLoading, WarningList } from './shared.tsx';

interface Props {
  context: string;
  dir: string | null;
  layout: 'page' | 'rail';
  lead?: ComponentChildren;
  onLive: (live: Live) => void;
  onNavigate: (kind: string) => void;
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const Bar = ({ label, fraction }: { label: string; fraction: number }) => <Progress value={fraction * 100} tone={barTone(fraction)} label={label} />;

interface CapacityProps {
  title: string;
  resource: Resource;
  text: (value: number | null | undefined) => string;
  unit: string;
  usageText: string;
}

/** Allocatable against what pods request and what is in use, for CPU or memory. */
const Capacity = ({ title, resource, text, unit, usageText }: CapacityProps) => {
  const requests = fractionOf(resource.requests, resource.allocatable);
  const usage = fractionOf(resource.usage, resource.allocatable);
  return (
    <Section title={title}>
      {resource.usage !== null && usage !== null ? <Bar label={`Usage ${text(resource.usage)} of ${text(resource.allocatable)}${unit}`} fraction={usage} /> : <div class="sui-muted sui-small">{usageText}</div>}
      {requests !== null ? <Bar label={`Requests ${text(resource.requests)} of ${text(resource.allocatable)}${unit}`} fraction={requests} /> : null}
      <KV
        items={[
          ['Allocatable', `${text(resource.allocatable)}${unit}`],
          ['Capacity', `${text(resource.capacity)}${unit}`],
          ['Limits', `${text(resource.limits)}${unit}${resource.allocatable > 0 ? ` (${Math.round((resource.limits / resource.allocatable) * 100)}%)` : ''}`],
        ]}
      />
    </Section>
  );
};

/** The cluster at a glance: nodes, pods, CPU and memory (capacity against requests and usage), and warnings. */
export const ClusterOverview = ({ context, dir, layout, lead, onLive, onNavigate }: Props) => {
  const nodes = useWatch({ context, namespace: '_all', kind: 'Node', dir });
  const pods = useWatch({ context, namespace: '_all', kind: 'Pod', dir });
  const events = useWatch({ context, namespace: '_all', kind: 'Event', dir, fieldSelector: 'type=Warning' });
  const usageView = useUsage({ context, dir, namespace: '_all', nodes: true, pods: false, enabled: true });
  const prom = usePromStatus(context, dir);
  const [choose, setChoose] = useState(false);
  const usage = usageView.usage;
  const live = combineLive([nodes.live, pods.live, events.live]);
  useEffect(() => onLive(live), [live]);

  const totals = useMemo(() => clusterTotals(nodes.items, pods.items, usage.status === 'ok' ? usage.nodes : null), [nodes.items, pods.items, usage]);
  const summary = useMemo(() => summarize('Pod', pods.items), [pods.items]);
  const warnings = useMemo(() => warningEvents(events.items, 8), [events.items]);
  const warningTotal = useMemo(() => events.items.filter((event) => event.type === 'Warning').length, [events.items]);

  const reload = (): void => {
    nodes.reload();
    pods.reload();
    events.reload();
  };
  const blocked = blockingError([nodes, pods, events]);
  if (blocked) return <OverviewFrame title="Cluster overview" layout={layout} lead={lead}><OverviewError error={blocked} context={context} onRetry={reload} /></OverviewFrame>;
  if ((nodes.phase === 'loading' && nodes.items.length === 0) || (pods.phase === 'loading' && pods.items.length === 0)) {
    return <OverviewFrame title="Cluster overview" layout={layout} lead={lead}><OverviewLoading label="Loading the cluster" /></OverviewFrame>;
  }

  const noNodes = isForbidden(nodes);
  const noPods = isForbidden(pods);
  const missing = usageNote(usage) || 'Reading usage';
  const now = Date.now();

  const nodePart = noNodes ? (
    <NoAccess what="Nodes" />
  ) : (
    <>
      <div class="k8s-ov-grid">
        <Capacity title="CPU" resource={totals.cpu} text={coresText} unit=" cores" usageText={missing} />
        <Capacity title="Memory" resource={totals.memory} text={bytesText} unit="" usageText={missing} />
        <Section title="Pods">
          {totals.pods.allocatable > 0 ? <Bar label={`Scheduled ${totals.pods.scheduled} of ${totals.pods.allocatable}`} fraction={totals.pods.scheduled / totals.pods.allocatable} /> : null}
          <KV items={[['Capacity', String(totals.pods.allocatable)], ['Running', String(totals.pods.running)], ['Pending', String(totals.pods.pending)], ['Failed', String(totals.pods.failed)]]} />
        </Section>
      </div>
    </>
  );

  const prometheusLine = (): ComponentChildren => {
    if (prom.phase === 'loading') return <span class="k8s-source-line"><Spinner label="Looking for Prometheus" /></span>;
    if (prom.phase === 'error' || !prom.status) return <span class="k8s-source-line"><Dot tone="muted" />Prometheus could not be checked.</span>;
    const status = prom.status;
    if (status.found) {
      return (
        <>
          <span class="k8s-source-line">
            <Dot tone="success" />
            <span>{`Prometheus: ${status.namespace}/${status.service} (${status.via === 'forward' ? 'through a port forward, the cluster API cannot reach it' : 'through the cluster API'}${status.source === 'override' ? ', your choice' : ''})`}</span>
          </span>
          <span class="k8s-source-actions">
            <Button label="Change service" size="xs" variant="ghost" onClick={() => setChoose(true)} />
          </span>
        </>
      );
    }
    const text = promMissingText(status);
    return (
      <>
        <span class="k8s-source-line"><Dot tone="muted" /><strong>{text.title}</strong></span>
        <div class="sui-muted sui-small">{text.body}</div>
        <span class="k8s-source-actions">
          <Button label="Choose service" size="xs" variant="outline" onClick={() => setChoose(true)} />
          <Button label="Look again" size="xs" variant="ghost" onClick={prom.reload} />
        </span>
      </>
    );
  };

  return (
    <OverviewFrame title="Cluster overview" layout={layout} lead={lead} note="Cluster-wide">
      <Cards>
        <StatCard
          label="Nodes"
          value={noNodes ? '-' : totals.nodes.total}
          breakdown={noNodes ? undefined : [{ tone: 'success', text: `${totals.nodes.ready} ready` }, ...(totals.nodes.notReady > 0 ? [{ tone: 'error' as const, text: `${totals.nodes.notReady} not ready` }] : []), ...(totals.nodes.cordoned > 0 ? [{ tone: 'warning' as const, text: `${totals.nodes.cordoned} cordoned` }] : [])]}
          onClick={() => onNavigate('Node')}
        />
        <StatCard label="Pods" value={noPods ? '-' : summary.total} breakdown={noPods ? undefined : summary.parts.map((part) => ({ tone: part.tone, text: part.text }))} onClick={() => onNavigate('Pod')} />
        <StatCard label="Warnings" value={isForbidden(events) ? '-' : warningTotal} breakdown={[{ tone: warningTotal > 0 ? 'warning' : 'muted', text: 'last hour' }]} onClick={() => onNavigate('Event')} />
      </Cards>
      {nodePart}
      <Section title="Warning events">
        {isForbidden(events) ? <NoAccess what="Events" /> : <WarningList events={warnings} total={warningTotal} now={now} loading={events.phase === 'loading' && events.items.length === 0} onAll={() => onNavigate('Event')} />}
      </Section>
      <Section title="Where the numbers come from">
        <div class="k8s-sources">
          <div class="k8s-source">
            <span class="k8s-source-line">
              <Dot tone={usage.status === 'ok' ? 'success' : usage.status === 'loading' ? 'muted' : 'warning'} />
              <span>{usage.status === 'ok' ? `metrics-server: usage as of ${clock(usage.at ?? now)}` : usage.status === 'loading' ? 'metrics-server: reading' : usageNote(usage)}</span>
            </span>
            {usage.status !== 'missing' && usage.status !== 'loading' ? (
              <span class="k8s-source-actions">
                <Button label="Refresh usage" size="xs" variant="ghost" loading={usageView.refreshing} onClick={usageView.refresh} />
              </span>
            ) : null}
          </div>
          <div class="k8s-source">{prometheusLine()}</div>
        </div>
      </Section>
      {choose ? (
        <PromServiceDialog
          context={context}
          dir={dir}
          current={prom.status}
          onSaved={(next) => prom.set(next)}
          onClose={() => setChoose(false)}
        />
      ) : null}
    </OverviewFrame>
  );
};
