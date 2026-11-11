import { Badge, Button, Empty, Spinner } from '../kit.tsx';
import { call, host, notify } from '../host.ts';
import { useForwards } from '../useForwards.ts';
import type { ForwardStatus, ForwardView } from '../../shared/types.ts';

interface Props {
  /** The cluster in the header, for a note about forwards on other clusters. */
  context: string | null;
  onClose?: () => void;
  /** Rail and dock: no page heading. */
  compact?: boolean;
}

const TONE: Record<ForwardStatus, 'success' | 'info' | 'error' | 'neutral'> = {
  live: 'success',
  starting: 'info',
  failed: 'error',
  stopped: 'neutral',
};

const LABEL: Record<ForwardStatus, string> = {
  live: 'Live',
  starting: 'Starting',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** Active port forwards: Open, Copy, Stop. The list survives the panel closing. */
export const ForwardsView = ({ context, onClose, compact }: Props) => {
  const { forwards, loading, error, refresh } = useForwards();

  const stop = async (forward: ForwardView): Promise<void> => {
    const reply = await call('POST', '/forward/stop', { id: forward.id });
    if (!reply.ok) notify('error', String(reply.error ?? 'Could not stop the forward.'));
  };

  const elsewhere = forwards.filter((forward) => context && forward.context !== context);

  return (
    <div class={`k8s-forwards${compact ? ' k8s-forwards--compact' : ''}`}>
      <div class="k8s-logs-head">
        <strong>Port forwarding</strong>
        {!loading ? <span class="sui-muted sui-small">{forwards.length === 1 ? '1 forward' : `${forwards.length} forwards`}</span> : null}
        <span class="k8s-push k8s-forwards-actions">
          <Button label="Refresh" size="xs" variant="ghost" onClick={refresh} />
          {onClose ? <Button label="Close" size="xs" variant="ghost" onClick={onClose} /> : null}
        </span>
      </div>
      {!compact ? (
        <div class="sui-muted sui-small">
          A forward keeps running when the panel closes. Starting the extension's service again puts it back. Dropped forwards restart up to 3 times.
        </div>
      ) : null}
      {loading && forwards.length === 0 ? <div class="k8s-center"><Spinner label="Loading forwards" /></div> : null}
      {error ? <div class="sui-small k8s-forwards-error">{error}</div> : null}
      {!loading && forwards.length === 0 && !error ? (
        <Empty title="No port forwards" body="Open a Pod or a Service and choose Port forward." />
      ) : null}
      {forwards.length > 0 ? (
        <div class="k8s-forwards-list">
          {forwards.map((forward) => (
            <div class="k8s-forward" key={forward.id}>
              <div class="k8s-forward-main">
                <div class="sui-row k8s-forward-title">
                  <Badge label={LABEL[forward.status]} tone={TONE[forward.status]} />
                  <strong class="k8s-ellipsis">{`${forward.kind}/${forward.name}`}</strong>
                  <span class="sui-muted sui-small">{forward.namespace}</span>
                </div>
                <div class="sui-muted sui-small k8s-forward-meta">
                  <span class="sui-mono">{`localhost:${forward.localPort} -> ${forward.remotePort}`}</span>
                  {forward.context !== context ? <span>{forward.context}</span> : null}
                  {forward.restarts > 0 ? <span>{`${forward.restarts} restarts`}</span> : null}
                  {forward.error ? <span class="k8s-wrap">{forward.error}</span> : null}
                </div>
              </div>
              <div class="k8s-forward-actions">
                <Button label="Open" size="xs" variant="outline" onClick={() => void host.openUrl(forward.url)} disabled={forward.status !== 'live'} />
                <Button label="Copy" size="xs" variant="ghost" onClick={() => void host.writeClipboard(forward.url)} />
                <Button label="Stop" size="xs" variant="ghost" onClick={() => void stop(forward)} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {elsewhere.length > 0 && compact ? <div class="sui-muted sui-small">{`${elsewhere.length} more on other clusters.`}</div> : null}
    </div>
  );
};
