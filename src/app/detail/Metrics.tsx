import { chartTargetOf } from '../../shared/prom.ts';
import type { Obj } from '../../shared/types.ts';
import { PromCharts } from '../charts/PromCharts.tsx';
import { Empty } from '../kit.tsx';

/** Kinds whose drawer has a Metrics tab. */
export const METRIC_KINDS = new Set(['Pod', 'Node', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job']);

interface Props {
  object: Obj;
  context: string;
  dir: string | null;
}

/** The Metrics tab: history charts from Prometheus. Current usage is in the Overview tab. */
export const Metrics = ({ object, context, dir }: Props) => {
  const target = chartTargetOf(object);
  if (!target) return <Empty title="No charts for this" body="Charts are drawn for pods, nodes and workloads." />;
  return (
    <PromCharts
      request={{
        context,
        dir,
        scope: target.scope,
        ...(target.scope === 'workload' ? { kind: target.kind } : {}),
        ...('namespace' in target ? { namespace: target.namespace } : {}),
        name: target.name,
        ...(target.scope === 'node' ? { addresses: target.addresses } : {}),
      }}
    />
  );
};
