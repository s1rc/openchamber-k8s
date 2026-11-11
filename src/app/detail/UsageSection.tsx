import { Section } from '@openchamber-ext/shared-ui/preact';
import { bytesText, cpuText } from '../../shared/format.ts';
import { nodeMeter, type Meter } from '../../shared/kinds.ts';
import { podUsageKey, usageNote, type UsageSet } from '../../shared/metrics.ts';
import { barTone, podRequests } from '../../shared/overview.ts';
import type { Obj } from '../../shared/types.ts';
import { Progress } from '../kit.tsx';

interface Props {
  object: Obj;
  usage: UsageSet;
}

const Bar = ({ label, fraction }: { label: string; fraction: number | null }) =>
  fraction === null ? <div class="sui-small">{label}</div> : <Progress value={fraction * 100} tone={barTone(fraction)} label={label} />;

const podRow = (what: 'CPU' | 'Memory', used: number | null, requests: number, limits: number): { label: string; fraction: number | null } => {
  const text = what === 'CPU' ? cpuText : bytesText;
  if (used === null) return { label: `${what}: no reading yet`, fraction: null };
  const of = limits > 0 ? { size: limits, word: 'limit' } : requests > 0 ? { size: requests, word: 'requested' } : null;
  if (!of) return { label: `${what} ${text(used)} (no requests or limits set)`, fraction: null };
  return { label: `${what} ${text(used)} of ${text(of.size)} ${of.word}`, fraction: used / of.size };
};

const meterRow = (what: string, meter: Meter | null): { label: string; fraction: number | null } =>
  meter ? { label: `${what} ${meter.text}`, fraction: meter.fraction } : { label: `${what}: no reading`, fraction: null };

/** Current usage for a pod or a node, from metrics-server. A cluster without it gets a note, never an error. */
export const UsageSection = ({ object, usage }: Props) => {
  if (usage.status === 'loading') return null;
  const note = usageNote(usage);
  if (note) {
    return (
      <Section title="Usage">
        <div class="sui-muted sui-small" title={usage.message}>{note}</div>
      </Section>
    );
  }
  if (object.kind === 'Node') {
    const ctx = { usage };
    const rows = [meterRow('CPU', nodeMeter(object, ctx, 'cpu')), meterRow('Memory', nodeMeter(object, ctx, 'memory'))];
    if (usage.diskStatus === 'ok') rows.push(meterRow('Disk', nodeMeter(object, ctx, 'disk')));
    return (
      <Section title="Usage">
        {rows.map((row) => <Bar label={row.label} fraction={row.fraction} />)}
      </Section>
    );
  }
  const used = usage.pods.get(podUsageKey(String(object.metadata?.namespace ?? ''), String(object.metadata?.name ?? '')));
  const room = podRequests(object);
  const rows = [podRow('CPU', used?.cpu ?? null, room.cpuRequests, room.cpuLimits), podRow('Memory', used?.memory ?? null, room.memoryRequests, room.memoryLimits)];
  return (
    <Section title="Usage">
      {rows.map((row) => <Bar label={row.label} fraction={row.fraction} />)}
      {!used ? <div class="sui-muted sui-small">metrics-server has no reading for this pod yet. New pods take a minute.</div> : null}
    </Section>
  );
};
