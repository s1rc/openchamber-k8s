import { useEffect, useState } from 'preact/hooks';
import type { AuditEntry } from '../shared/ops.ts';
import type { Reply } from '@openchamber-ext/shared-ui';
import { call } from './host.ts';
import { Button, Empty, Spinner } from './kit.tsx';
import { Modal } from './Modal.tsx';

interface Props {
  context: string;
  dir: string | null;
  onClose: () => void;
}

const when = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : iso;
};

/** The audit log: every real write the panel or the agent made, newest first. */
export const ActivityView = ({ context, dir, onClose }: Props) => {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const reply: Reply = await call('GET', '/audit', { dir, context, limit: 200 });
    if (!reply.ok) {
      setError(String(reply.error ?? 'Could not read the audit log.'));
      setEntries([]);
      return;
    }
    setError(null);
    setEntries((reply.entries ?? []) as AuditEntry[]);
  };

  useEffect(() => {
    void load();
  }, [context, dir]);

  const shown = entries ?? [];

  return (
    <Modal
      title="Activity"
      onClose={onClose}
      wide
      footer={
        <>
          <Button label="Refresh" size="sm" variant="outline" onClick={() => void load()} />
          <Button label="Close" size="sm" variant="ghost" onClick={onClose} />
        </>
      }
    >
      <div class="sui-muted sui-small">Writes made through this extension on this cluster. Tokens and Secret values are never written here.</div>
      {entries === null ? <div class="k8s-center"><Spinner label="Reading the audit log" /></div> : null}
      {error ? <div class="k8s-dialog-error sui-small">{error}</div> : null}
      {entries && shown.length === 0 && !error ? <Empty title="No writes yet" body="Actions you take in the panel appear here, with agent writes." /> : null}
      {shown.length > 0 ? (
        <div class="k8s-scroll-x">
          <table class="k8s-mini">
            <thead>
              <tr>
                <th>When</th>
                <th>Cluster</th>
                <th>Action</th>
                <th>Target</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 200).map((entry, at) => (
                <tr key={`${entry.time}:${at}`}>
                  <td class="sui-small">{when(entry.time)}</td>
                  <td>{entry.context}</td>
                  <td>{entry.verb}</td>
                  <td class="sui-mono sui-small k8s-wrap">{entry.target}</td>
                  <td class="sui-small">{entry.source === 'agent' ? 'Agent' : 'Panel'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
};
