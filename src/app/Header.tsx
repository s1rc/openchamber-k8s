import { useMemo } from 'preact/hooks';
import { Chip, Dot } from '@openchamber-ext/shared-ui/preact';
import type { ScopeResult } from '../shared/types.ts';
import { Badge, Button, Select } from './kit.tsx';
import { useWatch, type Live } from './useWatch.ts';

export interface ContextRow {
  name: string;
  account: string | null;
  region: string | null;
  clusterName: string;
  namespace: string | null;
  protected: boolean;
  locked: boolean;
  unlockedUntil: number | null;
}

interface Props {
  contexts: ContextRow[];
  context: string | null;
  namespace: string;
  dir: string | null;
  scope: ScopeResult | null;
  live: Live;
  layout: 'page' | 'rail';
  onPickContext: (name: string) => void;
  onPickNamespace: (name: string) => void;
  onUnlock: (name: string) => void;
  onLockNow: (name: string) => void;
  onActivity: () => void;
}

const LIVE_LOOK: Record<Live, { tone: 'success' | 'warning' | 'error' | 'muted'; label: string }> = {
  connecting: { tone: 'muted', label: 'Connecting' },
  live: { tone: 'success', label: 'Live' },
  reconnecting: { tone: 'warning', label: 'Reconnecting' },
  offline: { tone: 'error', label: 'Offline' },
};

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const Header = ({ contexts, context, namespace, dir, scope, live, layout, onPickContext, onPickNamespace, onUnlock, onLockNow, onActivity }: Props) => {
  const namespaces = useWatch(context ? { context, namespace: '_all', kind: 'Namespace', dir } : null);
  const current = contexts.find((row) => row.name === context) ?? null;

  const contextOptions = useMemo(
    () =>
      [...contexts]
        .sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.name.localeCompare(b.name))
        .map((row) => ({
          id: row.name,
          label: row.name,
          hint: [row.account, row.region, row.protected ? 'protected' : null].filter(Boolean).join(' \u00b7 '),
        })),
    [contexts],
  );

  const namespaceOptions = useMemo(() => {
    const names = new Set(namespaces.items.map((item) => String(item.metadata?.name ?? '')).filter(Boolean));
    if (namespace !== '_all') names.add(namespace);
    return [{ id: '_all', label: 'All namespaces' }, ...[...names].sort().map((name) => ({ id: name, label: name }))];
  }, [namespaces.items, namespace]);

  const look = LIVE_LOOK[live];
  const sourceMatches = scope && context && scope.context === context;

  return (
    <header class={`k8s-header k8s-header--${layout}`}>
      <div class="k8s-header-picks">
        <div class="k8s-pick k8s-pick--context">
          <Select
            value={context}
            options={contextOptions}
            onChange={onPickContext}
            placeholder="Choose a cluster"
            searchable
            searchPlaceholder="Search clusters"
          />
        </div>
        <div class="k8s-pick k8s-pick--namespace">
          <Select value={namespace} options={namespaceOptions} onChange={onPickNamespace} placeholder="Namespace" searchable searchPlaceholder="Search namespaces" disabled={!context} />
        </div>
      </div>
      <div class="k8s-header-state">
        {sourceMatches && scope ? (
          <span title={scope.reasons.join('\n') || scope.source}>
            <Chip>{scope.source}</Chip>
          </span>
        ) : null}
        {current?.protected ? (
          <span class="k8s-lock" title={current.locked ? 'Production clusters are read-only until you unlock them.' : 'Writes are allowed until the unlock ends. Lock it again when you are done.'}>
            <Badge label={current.locked ? 'Locked' : current.unlockedUntil ? `Unlocked until ${clock(current.unlockedUntil)}` : 'Unlocked'} tone={current.locked ? 'warning' : 'error'} />
            {current.locked ? (
              <Button label="Unlock" size="xs" variant="outline" onClick={() => onUnlock(current.name)} />
            ) : (
              <Button label="Lock now" size="xs" variant="outline" onClick={() => onLockNow(current.name)} />
            )}
          </span>
        ) : null}
        {current ? <Button label="Activity" size="xs" variant="ghost" onClick={onActivity} /> : null}
        {context ? (
          <span class="k8s-live" title={look.label}>
            <Dot tone={look.tone} />
            <span class="sui-muted sui-small">{look.label}</span>
          </span>
        ) : null}
        {!scope && dir ? <span class="sui-muted sui-small">Pick a cluster to remember it for this project</span> : null}
      </div>
    </header>
  );
};
