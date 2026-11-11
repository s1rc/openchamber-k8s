import { useState } from 'preact/hooks';
import { call } from '../host.ts';
import { Button, TextField } from '../kit.tsx';
import { Modal } from '../Modal.tsx';
import type { PromStatus } from '../usePrometheus.ts';

interface Props {
  context: string;
  dir: string | null;
  current: PromStatus | null;
  onSaved: (status: PromStatus) => void;
  onClose: () => void;
}

/** Lets the user name the Prometheus Service when detection finds none, or the wrong one. Saved per cluster, on this computer only. */
export const PromServiceDialog = ({ context, dir, current, onSaved, onClose }: Props) => {
  const [namespace, setNamespace] = useState(current?.namespace ?? '');
  const [service, setService] = useState(current?.service ?? '');
  const [port, setPort] = useState(current?.port ?? '9090');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    const reply = await call('POST', '/prometheus/service', { context, dir, ...body });
    setBusy(false);
    if (!reply.ok) return setError(String(reply.error ?? 'Could not save this.'));
    onSaved(reply as unknown as PromStatus);
    onClose();
  };

  return (
    <Modal
      title="Prometheus service"
      onClose={onClose}
      footer={
        <>
          <Button label="Save and check" size="sm" loading={busy} onClick={() => void send({ namespace, service, port })} />
          {current?.source === 'override' ? <Button label="Use automatic detection" size="sm" variant="outline" disabled={busy} onClick={() => void send({ clear: true })} /> : null}
          <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} />
        </>
      }
    >
      <div class="sui-muted sui-small">{`Charts for ${context} read from this Service. It is saved on this computer only. The check can take up to 30 seconds.`}</div>
      <TextField label="Namespace" value={namespace} onChange={setNamespace} placeholder="monitoring" mono />
      <TextField label="Service" value={service} onChange={setService} placeholder="prometheus-server" mono />
      <TextField label="Port" value={port} onChange={setPort} placeholder="9090" mono helper="A port number or the port name." />
      {error ? <div class="sui-small k8s-dialog-error">{error}</div> : null}
    </Modal>
  );
};
