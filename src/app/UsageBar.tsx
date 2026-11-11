import { usageNote } from '../shared/metrics.ts';
import { Button } from './kit.tsx';
import type { UsageView } from './useUsage.ts';

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** One line above a table with usage columns: when the numbers are from, or why there are none. Refresh is a click, never a timer. */
export const UsageBar = ({ view }: { view: UsageView }) => {
  const { usage, refreshing, refresh } = view;
  if (usage.status === 'loading') return <span class="sui-muted sui-small">Reading usage</span>;
  const note = usageNote(usage);
  return (
    <span class="k8s-usage-bar sui-small">
      {note ? (
        <span class="sui-muted" title={usage.message}>{note}</span>
      ) : (
        <span class="sui-muted">{`Usage as of ${clock(usage.at ?? Date.now())}`}</span>
      )}
      {usage.diskStatus && usage.diskStatus !== 'ok' ? <span class="sui-muted">Disk usage is not readable here</span> : null}
      {usage.status !== 'missing' ? <Button label="Refresh usage" size="xs" variant="ghost" loading={refreshing} onClick={refresh} /> : null}
    </span>
  );
};
