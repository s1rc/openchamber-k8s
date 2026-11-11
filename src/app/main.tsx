import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '@openchamber-ext/shared-ui';
import { Chip, Section } from '@openchamber-ext/shared-ui/preact';

const host = connectHost();

interface ContextRow {
  name: string;
  account: string | null;
  protected: boolean;
  locked: boolean;
}

const App = () => {
  const [ctx, setCtx] = useState<HostReadyContext | null>(null);
  const [rows, setRows] = useState<ContextRow[] | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => host.onReady((next) => {
    applyHostReady(next, document.documentElement);
    setCtx(next);
  }), []);

  const directory = ctx?.directory ?? null;
  useEffect(() => {
    void api(host, 'GET', '/contexts', { name: 'Kubernetes', query: { dir: directory } }).then((reply) => {
      if (!reply.ok) return setNote(String(reply.error ?? 'Something went wrong.'));
      setRows(reply.contexts as ContextRow[]);
      setNote('');
    });
  }, [directory]);

  return (
    <div class="k8s-pad">
      <Section title="Kubernetes">
        <div>Hello from the {ctx?.surface ?? 'panel'}.</div>
        {note ? <div class="sui-muted sui-small">{note}</div> : null}
        {rows === null ? <div class="sui-muted sui-small">Loading clusters.</div> : rows.map((row) => (
          <div class="sui-row">
            <span class="sui-mono sui-small sui-grow">{row.name}</span>
            {row.protected ? <Chip>{row.locked ? 'Locked' : 'Unlocked'}</Chip> : null}
          </div>
        ))}
      </Section>
    </div>
  );
};

render(<App />, document.getElementById('root')!);
