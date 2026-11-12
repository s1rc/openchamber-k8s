import { useEffect, useMemo, useState } from 'preact/hooks';
import { stringify, parse } from 'yaml';
import { isSecret } from '../../shared/kinds.ts';
import type { Obj } from '../../shared/types.ts';
import { call, notify } from '../host.ts';
import { Badge, Button, Spinner, TextField } from '../kit.tsx';
import { CopyButton } from '../CopyButton.tsx';
import { Modal } from '../Modal.tsx';
import { diffCount, diffLines } from './diff.ts';

interface Props {
  object: Obj;
  context: string;
  dir: string | null;
  namespace: string;
  editing: boolean;
  onEditing: (editing: boolean) => void;
}

const nameOf = (object: Obj): string => String(object.metadata?.name ?? '');
const kindOf = (object: Obj): string => String(object.kind ?? '');

/** The object as YAML. In edit mode the text goes through a server-side dry run and a diff before Save. */
export const Yaml = ({ object, context, dir, namespace, editing, onEditing }: Props) => {
  const base = useMemo(() => stringify(object, { lineWidth: 0, indent: 2 }), [object]);
  const [source, setSource] = useState(base);
  const [draft, setDraft] = useState(base);
  const [check, setCheck] = useState<{ added: number; removed: number; lines: ReturnType<typeof diffLines>; force: boolean } | null>(null);
  const [checkedText, setCheckedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [loadingSecret, setLoadingSecret] = useState(false);
  const secret = isSecret({ kind: kindOf(object), group: '' });

  useEffect(() => {
    if (!editing) return;
    setSource(base);
    setDraft(base);
    setCheck(null);
    setCheckedText(null);
    setError(null);
    if (!secret) return;
    setLoadingSecret(true);
    void call('GET', '/get', { context, dir, kind: 'Secret', namespace, name: nameOf(object), reveal: 1 }).then((reply) => {
      setLoadingSecret(false);
      if (!reply.ok) {
        setError(String(reply.error ?? 'Could not read the Secret.'));
        return;
      }
      const text = stringify(reply.object, { lineWidth: 0, indent: 2 });
      setSource(text);
      setDraft(text);
    });
    // The draft is a snapshot taken when the editor opens; watch updates must not overwrite typing.
  }, [editing]);

  const dirty = draft !== source;

  const dryRun = async (force = false): Promise<void> => {
    setError(null);
    setConflict(false);
    let parsed: unknown;
    try {
      parsed = parse(draft);
    } catch (thrown) {
      setError(`The YAML is not valid: ${thrown instanceof Error ? thrown.message.split('\n')[0] : 'check it again.'}`);
      return;
    }
    const candidate = parsed as Obj;
    if (!candidate || typeof candidate !== 'object' || candidate.kind !== kindOf(object) || candidate.metadata?.name !== nameOf(object)) {
      setError(`Keep the same kind and name: ${kindOf(object)}/${nameOf(object)}.`);
      return;
    }
    setBusy(true);
    const reply = await call('POST', '/apply', { context, dir, kind: kindOf(object), name: nameOf(object), namespace, manifest: draft, dryRun: true, ...(force ? { force: true } : {}) });
    setBusy(false);
    if (!reply.ok) {
      if (reply.code === 'CONFLICT') setConflict(true);
      setError(String(reply.error ?? 'The cluster refused the change.'));
      setCheck(null);
      return;
    }
    const lines = diffLines(source, draft);
    setCheck({ ...diffCount(lines), lines, force });
    setCheckedText(draft);
  };

  const save = async (): Promise<void> => {
    setConfirm(false);
    if (!check) return;
    setBusy(true);
    const reply = await call('POST', '/apply', { context, dir, kind: kindOf(object), name: nameOf(object), namespace, manifest: draft, ...(check.force ? { force: true } : {}) });
    setBusy(false);
    if (!reply.ok) {
      setError(String(reply.error ?? 'The cluster refused the change.'));
      return;
    }
    notify('success', `${kindOf(object)}/${nameOf(object)} saved.`);
    onEditing(false);
  };

  if (!editing) {
    return (
      <div class="k8s-yaml-wrap">
        <div class="sui-row">
          <span class="sui-muted sui-small">Read only.</span>
          <span class="k8s-push" />
          <CopyButton text={base} done="YAML copied" />
          <Button label="Edit" size="xs" variant="outline" onClick={() => onEditing(true)} />
        </div>
        <pre class="k8s-yaml sui-mono">{base}</pre>
      </div>
    );
  }

  return (
    <div class="k8s-yaml-wrap">
      <div class="sui-row">
        <Badge label="Editing" tone="warning" />
        <span class="sui-muted sui-small">{`${kindOf(object)}/${nameOf(object)}`}</span>
        <span class="k8s-push" />
        <Button label="Discard" size="xs" variant="ghost" onClick={() => onEditing(false)} disabled={busy} />
      </div>
      {secret ? <div class="sui-small k8s-dialog-note">This editor holds the Secret's values, shown because you chose Edit. Close it when you are done.</div> : null}
      {loadingSecret ? <div class="k8s-center"><Spinner label="Reading the Secret" /></div> : null}
      <div class="k8s-editor">
        <TextField value={draft} onChange={(value) => { setDraft(value); setCheck(null); setConflict(false); }} multiline rows={22} mono disabled={busy || loadingSecret} />
      </div>
      <div class="sui-row k8s-editor-actions">
        <Button label={busy ? 'Checking' : 'Check changes'} size="sm" variant="outline" loading={busy} onClick={() => void dryRun()} disabled={!dirty || loadingSecret} />
        <Button label="Save" size="sm" onClick={() => setConfirm(true)} disabled={!check || checkedText !== draft || busy} />
        {!dirty ? <span class="sui-muted sui-small">Nothing changed.</span> : null}
      </div>
      {error ? <div class="k8s-dialog-error sui-small k8s-wrap">{error}</div> : null}
      {conflict ? (
        <div class="k8s-conflict">
          <div class="sui-small">Another tool manages some of these fields. Checking with force takes them over, the same as kubectl apply --server-side --force-conflicts.</div>
          <Button label="Check with force" size="sm" variant="outline" loading={busy} onClick={() => void dryRun(true)} />
        </div>
      ) : null}
      {check ? (
        <div class="k8s-diff">
          <div class="sui-row">
            <strong class="sui-small">{check.force ? 'The cluster accepted the change with force' : 'The cluster accepted the change'}</strong>
            <span class="sui-muted sui-small">{`+${check.added} -${check.removed}`}</span>
          </div>
          <pre class="k8s-diff-body sui-mono">
            {check.lines.map((line) => (
              <span class={`k8s-diff-line k8s-diff-line--${line.kind}`}>{`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}`}</span>
            ))}
          </pre>
        </div>
      ) : null}
      {confirm ? (
        <Modal
          title={`Save ${kindOf(object)}/${nameOf(object)}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button label="Save" size="sm" loading={busy} onClick={() => void save()} />
              <Button label="Cancel" size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={busy} />
            </>
          }
        >
          <div class="k8s-wrap">{`The change was accepted by the cluster in a dry run. Saving writes it to ${kindOf(object)}/${nameOf(object)}.${check?.force ? ' Conflicting fields are taken over from the other tool.' : ''}`}</div>
        </Modal>
      ) : null}
    </div>
  );
};
