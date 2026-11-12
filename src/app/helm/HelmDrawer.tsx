import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Dot, KV, Section } from '@openchamber-ext/shared-ui/preact';
import { stringify } from 'yaml';
import { ageText } from '../../shared/format.ts';
import { helmStatus, type HelmHistoryEntry, type HelmRelease } from '../../shared/helm.ts';
import { REDACTED } from '../../shared/redact.ts';
import { ErrorState } from '../errors.tsx';
import { host, notify } from '../host.ts';
import { Banner, Button, Menu, Spinner, Switch, Tabs } from '../kit.tsx';
import { RollbackDialog, UninstallDialog, UpgradeDialog } from './HelmDialogs.tsx';
import { useRead } from './useRead.ts';

interface Props {
  release: HelmRelease;
  gone: boolean;
  context: string;
  dir: string | null;
  now: number;
  rail: boolean;
  onClose: () => void;
  /** A change was made: the release list reads again. */
  onChanged: () => void;
}

type TabId = 'overview' | 'values' | 'manifest' | 'history';
type Dialog = { kind: 'rollback'; initial?: number } | { kind: 'upgrade' } | { kind: 'uninstall' };

const count = (text: string, needle: string): number => text.split(needle).length - 1;

const when = (iso: string | null, now: number): string => (iso ? `${new Date(iso).toLocaleString()} (${ageText(Date.parse(iso), now)} ago)` : '');

const Overview = ({ release, now }: { release: HelmRelease; now: number }) => {
  const status = helmStatus(release.status);
  const rows: Array<[string, ComponentChildren]> = [
    ['Name', <span class="sui-mono k8s-wrap">{release.name}</span>],
    ['Namespace', release.namespace],
    ['Chart', release.chartName],
    ['Chart version', release.chartVersion],
    ['App version', release.appVersion],
    ['Revision', String(release.revision)],
    ['Status', <span class="k8s-status"><Dot tone={status.tone} />{status.label}</span>],
    ['Updated', when(release.updated, now)],
  ];
  return (
    <div class="k8s-overview">
      <Section>
        <KV items={rows.filter((row) => row[1] !== '')} />
      </Section>
      <div class="sui-muted sui-small k8s-wrap">Values, the manifest and the history are in the tabs above. Helm does not push changes: use Refresh in the list to read again.</div>
    </div>
  );
};

const ValuesTab = ({ release, context, dir, onEdit }: { release: HelmRelease; context: string; dir: string | null; onEdit: () => void }) => {
  const [all, setAll] = useState(false);
  const [values, reload] = useRead('/helm/values', { context, dir, namespace: release.namespace, name: release.name, all: all ? '1' : undefined, revision: String(release.revision) }, (reply) => (reply.values ?? {}) as Record<string, unknown>);
  if (values.phase === 'loading') return <div class="k8s-center"><Spinner label="Reading the values" /></div>;
  if (values.phase === 'error') return <ErrorState error={values.error} context={context} onRetry={reload} />;
  const text = Object.keys(values.data).length === 0 ? '# This release has no values of its own.\n{}\n' : stringify(values.data, { lineWidth: 0, indent: 2 });
  const hidden = count(text, REDACTED);
  return (
    <div class="k8s-yaml-wrap">
      <div class="sui-row">
        <Switch label="Computed values" description="With the chart's defaults" checked={all} onChange={setAll} />
        <span class="k8s-push" />
        <Button label="Refresh" size="xs" variant="outline" onClick={reload} />
        <Button label="Copy" size="xs" variant="ghost" onClick={() => { void host.writeClipboard(text); notify('success', 'Values copied.'); }} />
        <Button label="Edit and upgrade" size="xs" onClick={onEdit} />
      </div>
      <div class="sui-muted sui-small k8s-wrap">
        {hidden > 0 ? `${hidden} values are hidden because their key looks like a secret (password, secret, token, key or credential).` : 'A value whose key looks like a secret (password, secret, token, key or credential) is hidden.'}
      </div>
      <pre class="k8s-yaml sui-mono">{text}</pre>
    </div>
  );
};

const ManifestTab = ({ release, context, dir }: { release: HelmRelease; context: string; dir: string | null }) => {
  const [manifest, reload] = useRead('/helm/manifest', { context, dir, namespace: release.namespace, name: release.name, revision: String(release.revision) }, (reply) => ({
    manifest: String(reply.manifest ?? ''),
    secrets: Number(reply.secrets ?? 0),
    masked: Number(reply.masked ?? 0),
    resources: (reply.resources ?? []) as string[],
  }));
  if (manifest.phase === 'loading') return <div class="k8s-center"><Spinner label="Reading the manifest" /></div>;
  if (manifest.phase === 'error') return <ErrorState error={manifest.error} context={context} onRetry={reload} />;
  const { data } = manifest;
  return (
    <div class="k8s-yaml-wrap">
      <div class="sui-row">
        <span class="sui-muted sui-small">{`${data.resources.length} objects`}</span>
        <span class="k8s-push" />
        <Button label="Refresh" size="xs" variant="outline" onClick={reload} />
        <Button label="Copy" size="xs" variant="ghost" onClick={() => { void host.writeClipboard(data.manifest); notify('success', 'Manifest copied.'); }} />
      </div>
      {data.secrets > 0 ? <div class="sui-muted sui-small k8s-wrap">{`${data.secrets} Secret ${data.secrets === 1 ? 'document is' : 'documents are'} hidden: the keys show, the values do not.`}</div> : null}
      {data.masked > 0 ? <div class="sui-muted sui-small k8s-wrap">{`${data.masked} ${data.masked === 1 ? 'value' : 'values'} in other objects look like ${data.masked === 1 ? 'a secret' : 'secrets'} (a password or token in a ConfigMap or an environment variable) and read <redacted>. Copy copies the hidden text.`}</div> : null}
      <pre class="k8s-yaml sui-mono">{data.manifest}</pre>
    </div>
  );
};

const HistoryTab = ({ release, context, dir, now, onRollback }: { release: HelmRelease; context: string; dir: string | null; now: number; onRollback: (revision: number) => void }) => {
  const [history, reload] = useRead('/helm/history', { context, dir, namespace: release.namespace, name: release.name }, (reply) => (reply.history ?? []) as HelmHistoryEntry[]);
  if (history.phase === 'loading') return <div class="k8s-center"><Spinner label="Reading the history" /></div>;
  if (history.phase === 'error') return <ErrorState error={history.error} context={context} onRetry={reload} />;
  return (
    <div class="k8s-yaml-wrap">
      <div class="sui-row">
        <span class="sui-muted sui-small">{`${history.data.length} revisions`}</span>
        <span class="k8s-push" />
        <Button label="Refresh" size="xs" variant="outline" onClick={reload} />
      </div>
      <div class="k8s-scroll-x">
        <table class="k8s-mini">
          <thead>
            <tr>
              <th>Revision</th>
              <th>Status</th>
              <th>Chart</th>
              <th>App</th>
              <th>Updated</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.data.map((entry) => {
              const status = helmStatus(entry.status);
              return (
                <tr key={entry.revision}>
                  <td>{entry.revision}</td>
                  <td><span class="k8s-status"><Dot tone={status.tone} />{status.label}</span></td>
                  <td>{entry.chart}</td>
                  <td>{entry.appVersion}</td>
                  <td title={entry.updated ? new Date(entry.updated).toLocaleString() : undefined}>{entry.updated ? ageText(Date.parse(entry.updated), now) : ''}</td>
                  <td class="k8s-wrap">{entry.description}</td>
                  <td>{entry.revision === release.revision ? <span class="sui-muted sui-small">Current</span> : <Button label="Roll back" size="xs" variant="outline" onClick={() => onRollback(entry.revision)} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** The drawer of one Helm release: Overview, Values, Manifest and History, with Rollback, Upgrade and Uninstall in the menu. */
export const HelmDrawer = ({ release, gone, context, dir, now, rail, onClose, onChanged }: Props) => {
  const [tab, setTab] = useState<TabId>('overview');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const id = `${release.namespace}/${release.name}`;
  const status = helmStatus(release.status);

  useEffect(() => {
    setTab('overview');
    setDialog(null);
  }, [id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !dialog) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dialog]);

  const items = [
    { id: 'rollback', label: 'Rollback' },
    { id: 'upgrade', label: 'Upgrade values' },
    { separator: true as const },
    { id: 'uninstall', label: 'Uninstall', destructive: true },
    { separator: true as const },
    { id: 'copy-name', label: 'Copy name' },
  ];

  const onSelect = (action: string): void => {
    if (action === 'rollback') setDialog({ kind: 'rollback' });
    else if (action === 'upgrade') setDialog({ kind: 'upgrade' });
    else if (action === 'uninstall') setDialog({ kind: 'uninstall' });
    else if (action === 'copy-name') {
      void host.writeClipboard(release.name);
      notify('success', 'Name copied.');
    }
  };

  const common = { release, context, dir, onClose: () => setDialog(null), onDone: onChanged };

  return (
    <aside class="k8s-drawer" aria-label={`${release.name} details`}>
      <div class="k8s-drawer-head">
        <Button label={rail ? 'Back' : 'Close'} size="xs" variant="ghost" onClick={onClose} />
        <div class="k8s-drawer-title">
          <span class="k8s-drawer-kind sui-muted sui-small">Helm release</span>
          <strong class="k8s-ellipsis" title={release.name}>{release.name}</strong>
        </div>
        <span class="k8s-status sui-small">
          <Dot tone={status.tone} />
          <span class="k8s-ellipsis">{status.label}</span>
        </span>
        {!gone ? <Menu label="Actions" size="xs" items={items} onSelect={onSelect} /> : null}
      </div>
      {gone ? <div class="k8s-pad"><Banner tone="warning" title="This release is gone" body="Helm no longer lists it. You are looking at the last copy the panel saw." /></div> : null}
      <div class="k8s-drawer-tabs">
        <Tabs
          items={[
            { id: 'overview', label: 'Overview' },
            { id: 'values', label: 'Values' },
            { id: 'manifest', label: 'Manifest' },
            { id: 'history', label: 'History' },
          ]}
          activeId={tab}
          onChange={(next) => setTab(next as TabId)}
        />
      </div>
      <div class="k8s-drawer-body">
        {tab === 'overview' ? <Overview release={release} now={now} /> : null}
        {tab === 'values' ? <ValuesTab release={release} context={context} dir={dir} onEdit={() => setDialog({ kind: 'upgrade' })} /> : null}
        {tab === 'manifest' ? <ManifestTab release={release} context={context} dir={dir} /> : null}
        {tab === 'history' ? <HistoryTab release={release} context={context} dir={dir} now={now} onRollback={(revision) => setDialog({ kind: 'rollback', initial: revision })} /> : null}
      </div>
      {dialog?.kind === 'rollback' ? <RollbackDialog {...common} initial={dialog.initial} /> : null}
      {dialog?.kind === 'upgrade' ? <UpgradeDialog {...common} /> : null}
      {dialog?.kind === 'uninstall' ? <UninstallDialog {...common} /> : null}
    </aside>
  );
};
