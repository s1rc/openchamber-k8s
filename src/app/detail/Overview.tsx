import type { ComponentChildren } from 'preact';
import { Chip, Dot, KV, Section } from '@openchamber-ext/shared-ui/preact';
import { ageText, clipText } from '../../shared/format.ts';
import { podSpecOf, statusOf, timeOf, type KindView } from '../../shared/kinds.ts';
import { nodeShellCommand, SHELL_COPIED, shellCommand } from '../../shared/shell.ts';
import type { Obj } from '../../shared/types.ts';
import { host, notify } from '../host.ts';
import { Button } from '../kit.tsx';

interface Props {
  object: Obj;
  view: KindView;
  now: number;
  context: string;
  namespace: string;
}

const arr = (value: unknown): Obj[] => (Array.isArray(value) ? (value as Obj[]) : []);
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
const CHIPS_SHOWN = 24;

const Chips = ({ values, empty }: { values: Record<string, unknown> | undefined; empty: string }) => {
  const entries = Object.entries(values ?? {}).filter(([key]) => key !== LAST_APPLIED);
  if (entries.length === 0) return <span class="sui-muted">{empty}</span>;
  return (
    <div class="k8s-chips">
      {entries.slice(0, CHIPS_SHOWN).map(([key, value]) => (
        <Chip>
          <span title={`${key}=${String(value)}`}>{clipText(`${key}=${String(value)}`, 70)}</span>
        </Chip>
      ))}
      {entries.length > CHIPS_SHOWN ? <Chip>{`+${entries.length - CHIPS_SHOWN} more`}</Chip> : null}
    </div>
  );
};

const Conditions = ({ conditions, now }: { conditions: Obj[]; now: number }) => (
  <div class="k8s-scroll-x">
    <table class="k8s-mini">
      <thead>
        <tr>
          <th>Type</th>
          <th>Status</th>
          <th>Reason</th>
          <th>Message</th>
          <th>Age</th>
        </tr>
      </thead>
      <tbody>
        {conditions.map((c) => (
          <tr>
            <td>{String(c.type ?? '')}</td>
            <td>{String(c.status ?? '')}</td>
            <td>{String(c.reason ?? '')}</td>
            <td class="k8s-wrap">{String(c.message ?? '')}</td>
            <td>{ageText(timeOf(c.lastTransitionTime ?? c.lastUpdateTime), now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const envText = (env: Obj): string => {
  const name = String(env.name ?? '');
  if (env.value !== undefined) return `${name} = ${clipText(String(env.value), 80)}`;
  const from = env.valueFrom ?? {};
  if (from.secretKeyRef) return `${name} from Secret ${String(from.secretKeyRef.name)} / ${String(from.secretKeyRef.key)}`;
  if (from.configMapKeyRef) return `${name} from ConfigMap ${String(from.configMapKeyRef.name)} / ${String(from.configMapKeyRef.key)}`;
  if (from.fieldRef) return `${name} from field ${String(from.fieldRef.fieldPath)}`;
  if (from.resourceFieldRef) return `${name} from resource ${String(from.resourceFieldRef.resource)}`;
  return name;
};

const probes = (container: Obj): string =>
  (['livenessProbe', 'readinessProbe', 'startupProbe'] as const)
    .filter((key) => container[key])
    .map((key) => {
      const probe = container[key] as Obj;
      const how = probe.httpGet ? `HTTP ${String(probe.httpGet.path ?? '/')}:${String(probe.httpGet.port)}` : probe.tcpSocket ? `TCP :${String(probe.tcpSocket.port)}` : probe.exec ? 'exec' : probe.grpc ? `gRPC :${String(probe.grpc.port)}` : '';
      return `${key.replace('Probe', '')} ${how}`.trim();
    })
    .join(', ');

const resources = (container: Obj): string => {
  const req = container.resources?.requests ?? {};
  const lim = container.resources?.limits ?? {};
  const names = [...new Set([...Object.keys(req), ...Object.keys(lim)])];
  return names.map((name) => `${name} ${String(req[name] ?? '-')} / ${String(lim[name] ?? '-')}`).join(', ');
};

const ContainerBlock = ({ container, status, kind }: { container: Obj; status: Obj | undefined; kind: string }) => {
  const env = arr(container.env);
  const mounts = arr(container.volumeMounts);
  const ports = arr(container.ports).map((p) => `${p.name ? `${String(p.name)} ` : ''}${String(p.containerPort)}/${String(p.protocol ?? 'TCP')}`);
  const state = status?.state ? Object.keys(status.state)[0] : null;
  return (
    <div class="k8s-container">
      <div class="sui-row">
        <strong>{String(container.name)}</strong>
        <Chip>{kind}</Chip>
        {state ? <Chip>{state === 'waiting' && status?.state.waiting?.reason ? String(status.state.waiting.reason) : state}</Chip> : null}
        {status ? <span class="sui-muted sui-small">{`${Number(status.restartCount ?? 0)} restarts`}</span> : null}
      </div>
      <KV
        items={[
          ['Image', <span class="sui-mono k8s-wrap">{String(container.image ?? '')}</span>],
          ...(ports.length > 0 ? ([['Ports', ports.join(', ')]] as Array<[string, ComponentChildren]>) : []),
          ...(resources(container) ? ([['Resources', <span class="sui-small">{resources(container)}</span>]] as Array<[string, ComponentChildren]>) : []),
          ...(probes(container) ? ([['Probes', probes(container)]] as Array<[string, ComponentChildren]>) : []),
        ]}
      />
      {env.length > 0 ? (
        <details class="k8s-details">
          <summary>{`Environment (${env.length})`}</summary>
          <ul class="k8s-list sui-mono sui-small">{env.map((e) => <li class="k8s-wrap">{envText(e)}</li>)}</ul>
        </details>
      ) : null}
      {mounts.length > 0 ? (
        <details class="k8s-details">
          <summary>{`Mounts (${mounts.length})`}</summary>
          <ul class="k8s-list sui-mono sui-small">{mounts.map((m) => <li class="k8s-wrap">{`${String(m.name)} at ${String(m.mountPath)}${m.readOnly ? ' (read only)' : ''}`}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
};

const Containers = ({ object }: { object: Obj }) => {
  const spec = podSpecOf(object);
  if (!spec) return null;
  const isPod = object.kind === 'Pod';
  const statuses = new Map([...arr(object.status?.containerStatuses), ...arr(object.status?.initContainerStatuses)].map((s) => [String(s.name), s]));
  const blocks = [
    ...arr(spec.initContainers).map((container) => ({ container, kind: 'Init' })),
    ...arr(spec.containers).map((container) => ({ container, kind: 'Container' })),
  ];
  if (blocks.length === 0) return null;
  return (
    <Section title="Containers">
      {blocks.map(({ container, kind }) => <ContainerBlock container={container} kind={kind} status={isPod ? statuses.get(String(container.name)) : undefined} />)}
    </Section>
  );
};

const SecretKeys = ({ object }: { object: Obj }) => {
  const entries = [...Object.entries((object.data ?? {}) as Obj), ...Object.entries((object.stringData ?? {}) as Obj)];
  return (
    <Section title="Data">
      <div class="sui-muted sui-small">Values are hidden.</div>
      {entries.length === 0 ? <span class="sui-muted">No keys.</span> : <KV items={entries.map(([key, value]) => [key, <span class="sui-muted sui-mono sui-small">{String(value)}</span>] as const)} />}
    </Section>
  );
};

const when = (ms: number | null, now: number): string => (ms === null ? '' : `${new Date(ms).toLocaleString()} (${ageText(ms, now)} ago)`);

export const Overview = ({ object, view, now, context, namespace }: Props) => {
  const meta = object.metadata ?? {};
  const status = statusOf(view, object);
  const owners = arr(meta.ownerReferences);
  const rows: Array<[string, ComponentChildren]> = [['Name', <span class="sui-mono k8s-wrap">{String(meta.name ?? '')}</span>]];
  if (meta.namespace) rows.push(['Namespace', String(meta.namespace)]);
  rows.push(['Created', when(timeOf(meta.creationTimestamp), now)]);
  if (status) rows.push(['Status', <span class="k8s-status"><Dot tone={status.tone} />{status.label}</span>]);
  if (owners.length > 0) rows.push(['Controlled by', owners.map((o) => `${String(o.kind)}/${String(o.name)}`).join(', ')]);
  if (meta.deletionTimestamp) rows.push(['Deleting since', when(timeOf(meta.deletionTimestamp), now)]);
  for (const [label, value] of view.details?.(object) ?? []) rows.push([label, <span class="k8s-wrap">{value}</span>]);
  const conditions = arr(object.status?.conditions);
  const podContainer = Array.isArray(object.spec?.containers) ? String((object.spec.containers as Obj[])[0]?.name ?? '') : '';
  const shellText = object.kind === 'Node' ? nodeShellCommand(context, String(meta.name ?? '')) : object.kind === 'Pod' ? shellCommand(context, String(meta.namespace ?? namespace) || 'default', String(meta.name ?? ''), podContainer || undefined) : '';

  return (
    <div class="k8s-overview">
      <Section>
        <KV items={rows} />
      </Section>
      {shellText ? (
        <Section title="Shell">
          <div class="sui-muted sui-small">Paste this in OpenChamber's terminal to open a shell. The panel never opens a terminal itself.</div>
          <pre class="k8s-yaml k8s-yaml--wrap sui-mono">{shellText}</pre>
          <Button
            label="Copy command"
            size="xs"
            variant="outline"
            onClick={() => {
              void host.writeClipboard(shellText);
              notify('success', SHELL_COPIED);
            }}
          />
        </Section>
      ) : null}
      <Section title="Labels">
        <Chips values={meta.labels} empty="No labels." />
      </Section>
      <Section title="Annotations">
        <Chips values={meta.annotations} empty="No annotations." />
      </Section>
      {object.kind === 'Secret' ? <SecretKeys object={object} /> : null}
      <Containers object={object} />
      {conditions.length > 0 ? (
        <Section title="Conditions">
          <Conditions conditions={conditions} now={now} />
        </Section>
      ) : null}
    </div>
  );
};
