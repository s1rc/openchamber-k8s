import { useEffect, useState } from 'preact/hooks';
import { parse, stringify } from 'yaml';
import { diffCount, diffLines, withContext, type ManifestDiff } from '../../shared/diff.ts';
import type { HelmHistoryEntry, HelmRelease } from '../../shared/helm.ts';
import { call, notify } from '../host.ts';
import { Badge, Button, List, Select, Spinner, Switch, TextField } from '../kit.tsx';
import { Modal } from '../Modal.tsx';
import { DiffBody, ManifestDiffView } from './ManifestDiffView.tsx';
import { useRead } from './useRead.ts';

interface Common {
  release: HelmRelease;
  context: string;
  dir: string | null;
  onClose: () => void;
  /** A change was made: the list and the drawer read again. */
  onDone: () => void;
}

const ErrorLine = ({ error }: { error: string | null }) => (error ? <div class="k8s-dialog-error sui-small k8s-wrap">{error}</div> : null);

const refOf = (release: HelmRelease): string => `${release.name} in ${release.namespace}`;

const base = (c: Common): Record<string, unknown> => ({ context: c.context, dir: c.dir, namespace: c.release.namespace, name: c.release.name });

// ---------------------------------------------------------------------------------------------------------------

type Check<T> = { phase: 'idle' } | { phase: 'checking' } | { phase: 'ready'; data: T } | { phase: 'error'; message: string };

/** Roll back to an earlier revision. The cluster is asked first and the objects that would change are shown. */
export const RollbackDialog = (props: Common & { initial?: number }) => {
  const { release, context, dir, onClose, onDone } = props;
  const [history] = useRead('/helm/history', { context, dir, namespace: release.namespace, name: release.name }, (reply) => (reply.history ?? []) as HelmHistoryEntry[]);
  const [chosen, setChosen] = useState<number | null>(props.initial ?? null);
  const [check, setCheck] = useState<Check<ManifestDiff>>({ phase: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (chosen === null) {
      setCheck({ phase: 'idle' });
      return;
    }
    let cancelled = false;
    setCheck({ phase: 'checking' });
    void call('POST', '/helm/rollback', { ...base(props), revision: chosen, dryRun: true }).then((reply) => {
      if (cancelled) return;
      if (reply.ok) setCheck({ phase: 'ready', data: reply.diff as ManifestDiff });
      else setCheck({ phase: 'error', message: String(reply.error ?? 'The check did not finish.') });
    });
    return () => {
      cancelled = true;
    };
  }, [chosen]);

  const run = async (): Promise<void> => {
    if (chosen === null) return;
    setBusy(true);
    const reply = await call('POST', '/helm/rollback', { ...base(props), revision: chosen });
    setBusy(false);
    if (reply.ok) {
      notify('success', `${release.name} rolled back to revision ${chosen}.`);
      onDone();
      onClose();
    } else setError(String(reply.error ?? 'Could not roll back.'));
  };

  const rows = history.phase === 'ready' ? history.data.filter((entry) => entry.revision !== release.revision) : [];
  return (
    <Modal
      title={`Rollback ${refOf(release)}`}
      onClose={() => (busy ? undefined : onClose())}
      wide
      footer={
        <>
          <Button label={chosen === null ? 'Pick a revision' : `Roll back to ${chosen}`} size="sm" variant="destructive" disabled={check.phase !== 'ready' || busy} loading={busy} onClick={() => void run()} />
          <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} disabled={busy} />
        </>
      }
    >
      <div class="sui-muted sui-small k8s-wrap">{`Now at revision ${release.revision}. A rollback creates a new revision with the chart and values of the one you pick.`}</div>
      {history.phase === 'loading' ? <div class="k8s-center"><Spinner label="Reading the history" /></div> : null}
      {history.phase === 'error' ? <ErrorLine error={history.error.message ?? 'Could not read the history.'} /> : null}
      {history.phase === 'ready' && rows.length === 0 ? <div class="sui-muted">There is no earlier revision to go back to.</div> : null}
      {rows.length > 0 ? (
        <List
          ariaLabel="Revisions"
          selectedId={chosen === null ? null : String(chosen)}
          onSelect={(id) => setChosen(Number(id))}
          items={rows.map((entry) => ({
            id: String(entry.revision),
            title: `Revision ${entry.revision}`,
            subtitle: [entry.chart, entry.appVersion ? `app ${entry.appVersion}` : '', entry.description].filter(Boolean).join(' - '),
            meta: entry.updated ? new Date(entry.updated).toLocaleString() : undefined,
          }))}
        />
      ) : null}
      {check.phase === 'checking' ? <div class="k8s-center"><Spinner label="Checking what would change" /></div> : null}
      {check.phase === 'error' ? <ErrorLine error={check.message} /> : null}
      {check.phase === 'ready' ? <ManifestDiffView diff={check.data} /> : null}
      <ErrorLine error={error} />
    </Modal>
  );
};

// ---------------------------------------------------------------------------------------------------------------

interface ChartSources {
  revision: number;
  chartName: string;
  chartVersion: string;
  candidates: Array<{ ref: string; version: string }>;
  rebuild: { ok: boolean; reason?: string };
  default: 'repo' | 'release' | null;
  repos: string[];
}

interface UpgradeCheck {
  revision: number;
  chart: { source: 'repo' | 'release'; ref: string; version: string };
  diff: ManifestDiff;
  /** What was checked, so a later edit turns the check stale. */
  values: string;
  choice: string;
}

const choiceOf = (sources: ChartSources): string => (sources.default === 'repo' && sources.candidates[0] ? `repo:${sources.candidates[0].ref}` : sources.default === 'release' ? 'release' : 'custom');

/**
 * Upgrade a release with edited values. The values are shown with secret-looking values hidden; a hidden value that you
 * leave alone is put back by the service. Check changes asks the cluster and shows the diff; only then can you upgrade.
 */
export const UpgradeDialog = (props: Common) => {
  const { release, context, dir, onClose, onDone } = props;
  const [values] = useRead('/helm/values', { context, dir, namespace: release.namespace, name: release.name }, (reply) => (reply.values ?? {}) as Record<string, unknown>);
  const [sources] = useRead('/helm/chart-source', { context, dir, namespace: release.namespace, name: release.name }, (reply) => reply as unknown as ChartSources);
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [customChart, setCustomChart] = useState('');
  const [customVersion, setCustomVersion] = useState('');
  const [check, setCheck] = useState<UpgradeCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (values.phase !== 'ready') return;
    const text = Object.keys(values.data).length === 0 ? '{}\n' : stringify(values.data, { lineWidth: 0, indent: 2 });
    setSource(text);
    setDraft(text);
  }, [values.phase]);

  useEffect(() => {
    if (sources.phase === 'ready' && choice === null) setChoice(choiceOf(sources.data));
  }, [sources.phase]);

  const loading = values.phase === 'loading' || sources.phase === 'loading';
  const dirty = draft !== source;
  const chartRequest = (): Record<string, unknown> => {
    if (choice === 'release') return { fromRelease: true };
    if (choice === 'custom') return { chart: customChart.trim(), ...(customVersion.trim() ? { version: customVersion.trim() } : {}) };
    const candidate = sources.phase === 'ready' ? sources.data.candidates.find((entry) => `repo:${entry.ref}` === choice) : undefined;
    return candidate ? { chart: candidate.ref, version: candidate.version } : {};
  };

  const stale = (): void => {
    setCheck(null);
    setConfirming(false);
    setError(null);
  };

  const runCheck = async (): Promise<void> => {
    setError(null);
    try {
      parse(draft);
    } catch (thrown) {
      setError(`The YAML is not valid: ${thrown instanceof Error ? thrown.message.split('\n')[0] : 'check it again.'}`);
      return;
    }
    setBusy(true);
    const reply = await call('POST', '/helm/upgrade', { ...base(props), values: draft, dryRun: true, ...chartRequest() });
    setBusy(false);
    if (!reply.ok) {
      setCheck(null);
      setError(String(reply.error ?? 'The check did not finish.'));
      return;
    }
    setCheck({ revision: Number(reply.revision), chart: reply.chart as UpgradeCheck['chart'], diff: reply.diff as ManifestDiff, values: draft, choice: choice ?? '' });
  };

  const upgrade = async (): Promise<void> => {
    if (!check) return;
    setBusy(true);
    const same = check.chart.source === 'release' ? { fromRelease: true } : { chart: check.chart.ref, version: check.chart.version };
    const reply = await call('POST', '/helm/upgrade', { ...base(props), values: check.values, expectedRevision: check.revision, ...same });
    setBusy(false);
    if (reply.ok) {
      notify('success', `${release.name} upgraded.`);
      onDone();
      onClose();
    } else {
      setConfirming(false);
      setError(String(reply.error ?? 'The upgrade did not finish.'));
    }
  };

  const ready = check !== null && check.values === draft && check.choice === (choice ?? '');
  const options = sources.phase === 'ready'
    ? [
        ...sources.data.candidates.map((entry) => ({ id: `repo:${entry.ref}`, label: `${entry.ref} ${entry.version}`, hint: 'from a repository' })),
        ...(sources.data.rebuild.ok ? [{ id: 'release', label: 'The chart kept in the release', hint: 'no repository needed' }] : []),
        { id: 'custom', label: 'Another chart' },
      ]
    : [];
  const valuesDiff = check ? withContext(diffLines(source, check.values), 3) : [];
  const counts = check ? diffCount(diffLines(source, check.values)) : null;

  return (
    <Modal
      title={`Upgrade ${refOf(release)}`}
      onClose={() => (busy ? undefined : onClose())}
      wide
      footer={
        confirming && ready ? (
          <>
            <Button label={`Upgrade to revision ${check!.revision + 1}`} size="sm" variant="destructive" loading={busy} onClick={() => void upgrade()} />
            <Button label="Back" size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy} />
          </>
        ) : (
          <>
            <Button label={busy ? 'Checking' : 'Check changes'} size="sm" variant="outline" loading={busy} disabled={loading || !dirty || (choice === 'custom' && !customChart.trim())} onClick={() => void runCheck()} />
            <Button label="Upgrade" size="sm" disabled={!ready || busy} onClick={() => setConfirming(true)} />
            <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} disabled={busy} />
          </>
        )
      }
    >
      {loading ? <div class="k8s-center"><Spinner label="Reading the release" /></div> : null}
      {values.phase === 'error' ? <ErrorLine error={values.error.message ?? 'Could not read the values.'} /> : null}
      {confirming && ready ? (
        <div class="k8s-wrap">
          {`Helm rendered the chart with these values. Upgrading writes revision ${check!.revision + 1} of ${release.name} and changes ${check!.diff.changed.length + check!.diff.added.length + check!.diff.removed.length} objects.${check!.diff.removed.length > 0 ? ` ${check!.diff.removed.length} objects are removed.` : ''} Helm cannot test the change against the cluster first: if the cluster refuses an object, the release is left with a failed revision, and you can roll back to the last good one.`}
        </div>
      ) : null}
      {values.phase === 'ready' && !(confirming && ready) ? (
        <>
          <div class="sui-muted sui-small k8s-wrap">
            These are the values you set for this release. A value that looks like a secret reads {'<redacted>'}: leave it alone and it stays as it is, or type a new value over it.
          </div>
          <div class="k8s-editor k8s-editor--short">
            <TextField value={draft} onChange={(value) => { setDraft(value); stale(); }} multiline rows={11} mono disabled={busy} />
          </div>
          {sources.phase === 'ready' ? (
            <div class="k8s-chart-source">
              <Select label="Chart" value={choice} options={options} onChange={(id) => { setChoice(id); stale(); }} disabled={busy} />
              {choice === 'custom' ? (
                <div class="k8s-chart-custom">
                  <TextField label="Chart" value={customChart} onChange={(value) => { setCustomChart(value); stale(); }} mono placeholder="repo/chart or oci://registry/chart" />
                  <TextField label="Version" value={customVersion} onChange={(value) => { setCustomVersion(value); stale(); }} mono placeholder="Latest" />
                </div>
              ) : null}
              {!sources.data.rebuild.ok && sources.data.candidates.length === 0 ? (
                <div class="sui-small k8s-dialog-note k8s-wrap">{`No repository you added to Helm has ${sources.data.chartName} ${sources.data.chartVersion}. ${sources.data.rebuild.reason ?? ''} Name the chart yourself.`}</div>
              ) : null}
            </div>
          ) : null}
          {sources.phase === 'error' ? <ErrorLine error={sources.error.message ?? 'Could not look for the chart.'} /> : null}
        </>
      ) : null}
      <ErrorLine error={error} />
      {ready && !confirming ? (
        <>
          <div class="sui-small k8s-wrap">
            {check!.chart.source === 'release' ? `Chart rebuilt from the release record, version ${check!.chart.version}.` : `Chart ${check!.chart.ref} version ${check!.chart.version}.`}
          </div>
          <div class="k8s-diff">
            <div class="sui-row">
              <strong class="sui-small">Your values</strong>
              <span class="sui-muted sui-small">{counts ? `+${counts.added} -${counts.removed}` : ''}</span>
            </div>
            <DiffBody lines={valuesDiff} />
          </div>
          <ManifestDiffView diff={check!.diff} />
        </>
      ) : null}
      {check && !ready ? <Badge label="Check again after your last change" tone="warning" /> : null}
    </Modal>
  );
};

// ---------------------------------------------------------------------------------------------------------------

/** Uninstall: lists what goes, then one click. */
export const UninstallDialog = (props: Common) => {
  const { release, onClose, onDone } = props;
  const gone = release.status === 'uninstalled';
  const [resources, setResources] = useState<string[] | null>(null);
  const [keepHistory, setKeepHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void call('POST', '/helm/uninstall', { ...base(props), dryRun: true }).then((reply) => {
      if (cancelled) return;
      if (reply.ok) setResources((reply.resources ?? []) as string[]);
      else {
        setResources([]);
        setError(String(reply.error ?? 'Could not check the uninstall.'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (): Promise<void> => {
    setBusy(true);
    const reply = await call('POST', '/helm/uninstall', { ...base(props), keepHistory });
    setBusy(false);
    if (reply.ok) {
      notify('success', `${release.name} uninstalled.`);
      onDone();
      onClose();
    } else setError(String(reply.error ?? 'The uninstall did not finish.'));
  };

  return (
    <Modal
      title={`Uninstall ${refOf(release)}?`}
      onClose={() => (busy ? undefined : onClose())}
      wide
      footer={
        <>
          <Button label="Uninstall" size="sm" variant="destructive" loading={busy} disabled={(resources === null && !gone) || busy} onClick={() => void run()} />
          <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} disabled={busy} />
        </>
      }
    >
      <div class="k8s-wrap">
        {gone
          ? 'Helm already removed the objects of this release and kept its history. Uninstalling now deletes the history too. This cannot be undone.'
          : `Helm removes every object this release created${keepHistory ? ' and keeps its history, so it can be rolled back or reinstalled' : ', and its history'}. This cannot be undone.`}
      </div>
      {gone ? null : <Switch label="Keep the release history" checked={keepHistory} onChange={setKeepHistory} disabled={busy} />}
      {resources === null && !gone ? <div class="k8s-center"><Spinner label="Listing the objects" /></div> : null}
      {resources && resources.length > 0 && !gone ? (
        <>
          <div class="sui-small sui-muted">{`${resources.length} objects are removed:`}</div>
          <div class="k8s-drain-list">
            {resources.map((entry) => (
              <div class="k8s-drain-pod" key={entry}>
                <span class="sui-mono k8s-ellipsis">{entry}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <ErrorLine error={error} />
    </Modal>
  );
};
