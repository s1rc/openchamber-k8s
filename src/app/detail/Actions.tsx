import { useEffect, useState } from 'preact/hooks';
import { stringify } from 'yaml';
import type { Reply } from '@openchamber-ext/shared-ui';
import { actionsFor, type ActionId } from '../../shared/actions.ts';
import { podSpecOf } from '../../shared/kinds.ts';
import { nodeShellCommand, SHELL_COPIED, shellCommand } from '../../shared/shell.ts';
import type { Obj } from '../../shared/types.ts';
import { call, copyText, host, notify } from '../host.ts';
import { Badge, Button, List, Menu, Select, Spinner, TextField } from '../kit.tsx';
import { Modal } from '../Modal.tsx';
import { portsOf } from '../useForwards.ts';

interface Props {
  object: Obj;
  context: string;
  dir: string | null;
  /** The object's namespace, or the panel's choice when the kind is cluster scoped. */
  namespace: string;
  onOpenLogs: () => void;
  onOpenConsole: () => void;
  onEdit: () => void;
}

type Dialog =
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; destructive?: boolean; run: () => Promise<Reply>; done: string }
  | { kind: 'scale' }
  | { kind: 'rollback' }
  | { kind: 'drain' }
  | { kind: 'forward' }
  | { kind: 'secret' };

const nameOf = (object: Obj): string => String(object.metadata?.name ?? '');
const kindOf = (object: Obj): string => String(object.kind ?? '');
const refOf = (object: Obj): string => `${kindOf(object)}/${nameOf(object)}`;

const ErrorLine = ({ error }: { error: string | null }) => (error ? <div class="k8s-dialog-error sui-small">{error}</div> : null);

/** The Actions menu of one resource, with the confirm step and the small dialogs behind it. */
export const Actions = ({ object, context, dir, namespace, onOpenLogs, onOpenConsole, onEdit }: Props) => {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = kindOf(object);
  const name = nameOf(object);
  const apiVersion = String(object.apiVersion ?? '');

  const close = (): void => {
    if (busy) return;
    setDialog(null);
    setError(null);
  };

  const fail = (reply: Reply): void => {
    setError(String(reply.error ?? 'The cluster did not accept the change.'));
  };

  const simple = async (path: string, extra: Record<string, unknown>): Promise<Reply> => call('POST', path, { context, dir, namespace, kind, name, apiVersion, ...extra });

  const ask = (title: string, body: string, confirmLabel: string, run: () => Promise<Reply>, done: string, destructive = true): void => {
    setError(null);
    setDialog({ kind: 'confirm', title, body, confirmLabel, destructive, run, done });
  };

  const copy = async (text: string, done: string): Promise<void> => {
    await copyText(text, done);
  };

  const onSelect = (id: string): void => {
    const action = id as ActionId;
    switch (action) {
      case 'logs':
        return onOpenLogs();
      case 'console':
        return onOpenConsole();
      case 'port-forward':
        setError(null);
        return setDialog({ kind: 'forward' });
      case 'edit':
        return onEdit();
      case 'reveal':
        setError(null);
        return setDialog({ kind: 'secret' });
      case 'copy-name':
        void copy(name, 'Name copied.');
        return;
      case 'copy-yaml':
        void copy(stringify(object, { lineWidth: 0, indent: 2 }), 'YAML copied.');
        return;
      case 'shell': {
        if (kind === 'Node') return void copy(nodeShellCommand(context, name), SHELL_COPIED);
        const spec = podSpecOf(object);
        const container = Array.isArray(spec?.containers) ? String((spec.containers as Obj[])[0]?.name ?? '') : '';
        return void copy(shellCommand(context, namespace || 'default', name, container || undefined), SHELL_COPIED);
      }
      case 'delete':
        return ask(
          `Delete ${refOf(object)}?`,
          kind === 'Namespace'
            ? 'Everything in this namespace is deleted. This cannot be undone.'
            : `${refOf(object)} is removed from the cluster. This cannot be undone.`,
          'Delete',
          () => simple('/delete', {}),
          `${refOf(object)} deleted.`,
        );
      case 'evict':
        return ask(`Evict ${refOf(object)}?`, 'The pod is removed through the Eviction API, so its budget and controllers are respected. It will be replaced.', 'Evict', () => simple('/evict', {}), 'Pod evicted.');
      case 'restart':
        return ask(
          `Restart ${refOf(object)}?`,
          'The pod template gets a new restart annotation and the controller rolls the pods. They restart one at a time.',
          'Restart',
          () => simple('/restart', {}),
          `${refOf(object)} restarted.`,
          false,
        );
      case 'scale':
        setError(null);
        return setDialog({ kind: 'scale' });
      case 'rollback':
        setError(null);
        return setDialog({ kind: 'rollback' });
      case 'toggle-pause': {
        const paused = object.spec?.paused === true;
        return ask(
          `${paused ? 'Resume' : 'Pause'} ${refOf(object)}?`,
          paused ? 'The Deployment applies its pending changes again.' : 'While paused, template changes do not roll out.',
          paused ? 'Resume' : 'Pause',
          () => simple('/pause', { paused: !paused }),
          `${refOf(object)} ${paused ? 'resumed' : 'paused'}.`,
          false,
        );
      }
      case 'trigger':
        return ask(`Trigger ${refOf(object)} now?`, 'A Job is created from the job template, as a scheduled run would be.', 'Trigger', () => simple('/trigger', {}), 'Run started.', false);
      case 'toggle-suspend': {
        const suspended = object.spec?.suspend === true;
        return ask(
          `${suspended ? 'Resume' : 'Suspend'} ${refOf(object)}?`,
          suspended ? 'Scheduled runs start again.' : 'No new runs start until it is resumed.',
          suspended ? 'Resume' : 'Suspend',
          () => simple('/suspend', { suspend: !suspended }),
          `${refOf(object)} ${suspended ? 'resumed' : 'suspended'}.`,
          false,
        );
      }
      case 'cordon':
        return void call('POST', '/cordon', { context, dir, kind: 'Node', name, unschedulable: true }).then((reply) => (reply.ok ? notify('success', `${name} cordoned.`) : notify('error', String(reply.error ?? 'Could not cordon the node.'))));
      case 'uncordon':
        return void call('POST', '/cordon', { context, dir, kind: 'Node', name, unschedulable: false }).then((reply) => (reply.ok ? notify('success', `${name} uncordoned.`) : notify('error', String(reply.error ?? 'Could not uncordon the node.'))));
      case 'drain':
        setError(null);
        return setDialog({ kind: 'drain' });
      case 'reconcile':
        return void simple('/flux', { action: 'reconcile' }).then((reply) => (reply.ok ? notify('success', 'Reconcile requested.') : notify('error', String(reply.error ?? 'Could not request a reconcile.'))));
      case 'refresh':
        return void simple('/argo', { action: 'refresh' }).then((reply) => (reply.ok ? notify('success', 'Refresh requested.') : notify('error', String(reply.error ?? 'Could not refresh the application.'))));
      case 'sync':
        return ask(`Sync ${refOf(object)}?`, 'Argo CD applies the application\'s target revision to the cluster.', 'Sync', () => simple('/argo', { action: 'sync' }), 'Sync started.', false);
      default:
        return undefined;
    }
  };

  const items = actionsFor(object).flatMap((action) => [
    ...(action.groupStart ? [{ separator: true as const }] : []),
    { id: action.id, label: action.label, destructive: action.destructive },
  ]);

  return (
    <>
      <Menu label="Actions" size="xs" items={items} onSelect={onSelect} />
      {dialog?.kind === 'confirm' ? (
        <ConfirmDialog title={dialog.title} body={dialog.body} confirmLabel={dialog.confirmLabel} destructive={dialog.destructive} busy={busy} error={error} onCancel={close} onConfirm={async () => {
          setBusy(true);
          const reply = await dialog.run();
          setBusy(false);
          if (reply.ok) {
            notify('success', dialog.done);
            setDialog(null);
            setError(null);
          } else fail(reply);
        }} />
      ) : null}
      {dialog?.kind === 'scale' ? <ScaleDialog object={object} context={context} dir={dir} namespace={namespace} onClose={close} /> : null}
      {dialog?.kind === 'rollback' ? <RollbackDialog object={object} context={context} dir={dir} namespace={namespace} onClose={close} /> : null}
      {dialog?.kind === 'drain' ? <DrainDialog name={name} context={context} dir={dir} onClose={close} /> : null}
      {dialog?.kind === 'forward' ? <ForwardDialog object={object} context={context} dir={dir} namespace={namespace} onClose={close} /> : null}
      {dialog?.kind === 'secret' ? <SecretDialog object={object} context={context} dir={dir} namespace={namespace} onClose={close} /> : null}
    </>
  );
};

const ConfirmDialog = ({ title, body, confirmLabel, destructive, busy, error, onCancel, onConfirm }: {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <Modal
    title={title}
    onClose={onCancel}
    footer={
      <>
        <Button label={confirmLabel} size="sm" variant={destructive ? 'destructive' : 'default'} loading={busy} onClick={onConfirm} />
        <Button label="Cancel" size="sm" variant="ghost" onClick={onCancel} disabled={busy} />
      </>
    }
  >
    <div class="k8s-wrap">{body}</div>
    <ErrorLine error={error} />
  </Modal>
);

const ScaleDialog = ({ object, context, dir, namespace, onClose }: { object: Obj; context: string; dir: string | null; namespace: string; onClose: () => void }) => {
  const [value, setValue] = useState(String(Number(object.spec?.replicas ?? 1)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = kindOf(object);
  const name = nameOf(object);
  const run = async (): Promise<void> => {
    const replicas = Number(value);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 10_000) {
      setError('Replicas must be a whole number from 0 to 10000.');
      return;
    }
    setBusy(true);
    const reply = await call('POST', '/scale', { context, dir, namespace, kind, name, replicas });
    setBusy(false);
    if (reply.ok) {
      notify('success', `${refOf(object)} scaled to ${replicas}.`);
      onClose();
    } else setError(String(reply.error ?? 'Could not scale.'));
  };
  return (
    <Modal
      title={`Scale ${refOf(object)}`}
      onClose={onClose}
      footer={
        <>
          <Button label="Scale" size="sm" loading={busy} onClick={() => void run()} />
          <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} disabled={busy} />
        </>
      }
    >
      <div class="sui-muted sui-small">{`Now ${Number(object.spec?.replicas ?? 1)} replicas.`}</div>
      <TextField label="Replicas" value={value} onChange={setValue} placeholder="3" mono />
      <ErrorLine error={error} />
    </Modal>
  );
};

interface RevisionRow {
  revision: number;
  name: string;
  created: string | null;
  images: string[];
}

const RollbackDialog = ({ object, context, dir, namespace, onClose }: { object: Obj; context: string; dir: string | null; namespace: string; onClose: () => void }) => {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = kindOf(object);
  const name = nameOf(object);

  useEffect(() => {
    let cancelled = false;
    void call('GET', '/revisions', { context, dir, namespace, kind, name }).then((reply) => {
      if (cancelled) return;
      if (!reply.ok) {
        setError(String(reply.error ?? 'Could not read the revision history.'));
        setRows([]);
        return;
      }
      setRows((reply.revisions ?? []) as RevisionRow[]);
      setCurrent(typeof reply.current === 'number' ? reply.current : null);
    });
    return () => {
      cancelled = true;
    };
  }, [context, dir, namespace, kind, name]);

  const run = async (): Promise<void> => {
    if (chosen === null) return;
    setBusy(true);
    const reply = await call('POST', '/rollback', { context, dir, namespace, kind, name, revision: chosen });
    setBusy(false);
    if (reply.ok) {
      notify('success', `${refOf(object)} rolled back to revision ${chosen}.`);
      onClose();
    } else setError(String(reply.error ?? 'Could not roll back.'));
  };

  return (
    <Modal
      title={`Rollback ${refOf(object)}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button label={chosen === null ? 'Pick a revision' : `Roll back to ${chosen}`} size="sm" disabled={chosen === null || busy} loading={busy} onClick={() => void run()} />
          <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} disabled={busy} />
        </>
      }
    >
      {rows === null ? <div class="k8s-center"><Spinner label="Reading the history" /></div> : null}
      {rows && rows.length === 0 ? <div class="sui-muted">No revisions to roll back to. A Deployment keeps one per changed pod template.</div> : null}
      {rows && rows.length > 0 ? (
        <List
          ariaLabel="Revisions"
          selectedId={chosen === null ? null : String(chosen)}
          onSelect={(id) => setChosen(Number(id))}
          items={rows.map((row) => ({
            id: String(row.revision),
            title: `Revision ${row.revision}`,
            subtitle: row.images.join(', '),
            meta: row.revision === current ? 'Current' : row.created ? new Date(row.created).toLocaleString() : undefined,
          }))}
        />
      ) : null}
      <ErrorLine error={error} />
    </Modal>
  );
};

interface DrainPod {
  name: string;
  namespace: string;
  kind: string;
  problem: string | null;
}

const DrainDialog = ({ name, context, dir, onClose }: { name: string; context: string; dir: string | null; onClose: () => void }) => {
  const [pods, setPods] = useState<DrainPod[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void call('GET', '/drain', { context, dir, name }).then((reply) => {
      if (cancelled) return;
      if (!reply.ok) {
        setError(String(reply.error ?? 'Could not list the pods on the node.'));
        setPods([]);
        return;
      }
      setPods((reply.pods ?? []) as DrainPod[]);
    });
    return () => {
      cancelled = true;
    };
  }, [context, dir, name]);

  const run = async (): Promise<void> => {
    setBusy(true);
    const reply = await call('POST', '/drain', { context, dir, name });
    setBusy(false);
    if (reply.ok) {
      notify('success', `${name} drained.`);
      setOutput(String(reply.output ?? ''));
      return;
    }
    setError(String(reply.error ?? 'The drain did not finish.'));
  };

  const blocked = (pods ?? []).filter((pod) => pod.problem);

  return (
    <Modal
      title={`Drain ${name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button label="Drain" size="sm" variant="destructive" loading={busy} onClick={() => void run()} disabled={busy || output !== null} />
          <Button label={output ? 'Done' : 'Cancel'} size="sm" variant="ghost" onClick={onClose} disabled={busy} />
        </>
      }
    >
      <div class="sui-small k8s-wrap">
        Pods are evicted with <span class="sui-mono">--ignore-daemonsets</span> and <span class="sui-mono">--delete-emptydir-data</span>. DaemonSet pods stay. This cannot be undone automatically.
      </div>
      {pods === null ? <div class="k8s-center"><Spinner label="Listing the pods" /></div> : null}
      {pods && pods.length === 0 && !error ? <div class="sui-muted">No pods run on this node.</div> : null}
      {pods && pods.length > 0 ? (
        <div class="k8s-drain-list">
          {pods.map((pod) => (
            <div class="k8s-drain-pod" key={`${pod.namespace}/${pod.name}`}>
              <span class="sui-mono k8s-ellipsis">{pod.name}</span>
              <span class="sui-muted sui-small">{pod.namespace}</span>
              <span class="sui-muted sui-small k8s-push">{pod.kind}</span>
              {pod.problem ? <Badge label={pod.problem} tone="warning" /> : null}
            </div>
          ))}
        </div>
      ) : null}
      {blocked.length > 0 ? <div class="sui-small k8s-dialog-note">{`${blocked.length} pods may need attention.`}</div> : null}
      {output !== null ? <pre class="k8s-yaml sui-mono">{output || 'Finished.'}</pre> : null}
      <ErrorLine error={error} />
    </Modal>
  );
};

const ForwardDialog = ({ object, context, dir, namespace, onClose }: { object: Obj; context: string; dir: string | null; namespace: string; onClose: () => void }) => {
  const ports = portsOf(object);
  const [remote, setRemote] = useState(String(ports[0] ?? ''));
  const [local, setLocal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = nameOf(object);
  const resource = kindOf(object) === 'Service' ? 'service' : 'pod';

  const run = async (): Promise<void> => {
    const remotePort = Number(remote);
    if (!Number.isInteger(remotePort) || remotePort < 1) {
      setError('Pick a port from 1 to 65535.');
      return;
    }
    setBusy(true);
    const reply = await call('POST', '/forward', { context, dir, namespace, resource, name, remotePort, ...(local.trim() ? { localPort: Number(local) } : {}) });
    setBusy(false);
    if (reply.ok) {
      notify('success', `Forward open on localhost:${Number((reply.forward as Obj | undefined)?.localPort ?? 0)}.`);
      onClose();
    } else setError(String(reply.error ?? 'Could not open the forward.'));
  };

  return (
    <Modal
      title={`Port forward ${refOf(object)}`}
      onClose={onClose}
      footer={
        <>
          <Button label="Open forward" size="sm" loading={busy} onClick={() => void run()} />
          <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} disabled={busy} />
        </>
      }
    >
      <div class="sui-muted sui-small">The forward keeps running after the panel closes, until you stop it.</div>
      {ports.length > 1 ? (
        <Select label="Container port" value={remote} options={ports.map((port) => ({ id: String(port), label: String(port) }))} onChange={setRemote} />
      ) : (
        <TextField label="Container port" value={remote} onChange={setRemote} mono placeholder="8080" />
      )}
      <TextField label="Local port" value={local} onChange={setLocal} mono placeholder="Pick a free port" helper="Leave empty and the panel picks one." />
      <ErrorLine error={error} />
    </Modal>
  );
};

const SecretDialog = ({ object, context, dir, namespace, onClose }: { object: Obj; context: string; dir: string | null; namespace: string; onClose: () => void }) => {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const name = nameOf(object);

  useEffect(() => {
    let cancelled = false;
    void call('GET', '/get', { context, dir, kind: 'Secret', namespace, name, reveal: 1 }).then((reply) => {
      if (cancelled) return;
      if (!reply.ok) {
        setError(String(reply.error ?? 'Could not read the Secret.'));
        setValues({});
        return;
      }
      const data = ((reply.object as Obj | undefined)?.data ?? {}) as Record<string, string>;
      const decoded: Record<string, string> = {};
      for (const [key, value] of Object.entries(data)) {
        try {
          decoded[key] = atob(value);
        } catch {
          decoded[key] = '<not readable>';
        }
      }
      setValues(decoded);
    });
    return () => {
      cancelled = true;
    };
  }, [context, dir, namespace, name]);

  const toggle = (key: string): void => setShown((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <Modal
      title={`Secret ${name}`}
      onClose={onClose}
      wide
      footer={<Button label="Close" size="sm" variant="ghost" onClick={onClose} />}
    >
      <div class="sui-muted sui-small">Values are fetched only for this dialog. Close it when you are done.</div>
      {values === null ? <div class="k8s-center"><Spinner label="Reading the Secret" /></div> : null}
      {values && Object.keys(values).length === 0 && !error ? <div class="sui-muted">This Secret has no keys.</div> : null}
      {values ? (
        <div class="k8s-secret-keys">
          {Object.entries(values).map(([key, value]) => (
            <div class="k8s-secret-key" key={key}>
              <div class="sui-row">
                <span class="sui-mono k8s-ellipsis">{key}</span>
                <span class="k8s-push" />
                <Button label={shown.has(key) ? 'Hide' : 'Reveal'} size="xs" variant="outline" onClick={() => toggle(key)} />
                <Button label="Copy" size="xs" variant="ghost" onClick={() => void host.writeClipboard(value)} />
              </div>
              {shown.has(key) ? <pre class="k8s-yaml sui-mono">{value}</pre> : <div class="sui-muted sui-small">{`${value.length} characters, hidden`}</div>}
            </div>
          ))}
        </div>
      ) : null}
      <ErrorLine error={error} />
    </Modal>
  );
};
