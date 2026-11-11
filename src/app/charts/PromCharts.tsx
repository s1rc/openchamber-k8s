import { useState } from 'preact/hooks';
import { ErrorState } from '../errors.tsx';
import { Button, Empty, Spinner } from '../kit.tsx';
import { useCharts, type ChartRequest, type PromStatus } from '../usePrometheus.ts';
import { Chart } from './Chart.tsx';
import { PromServiceDialog } from './PromService.tsx';

/** The words for each way Prometheus can be missing. Shared by the Metrics tab and the overview. */
export const promMissingText = (status: Pick<PromStatus, 'reason' | 'tried'>): { title: string; body: string } => {
  if (status.reason === 'forbidden') {
    return { title: 'Prometheus could not be looked for', body: 'Your account may not list Services in this cluster. If you know where Prometheus runs, choose its Service.' };
  }
  if (status.reason === 'unreachable') {
    return {
      title: 'Prometheus found, but not reachable',
      body: `Found ${(status.tried ?? []).join(', ') || 'a Prometheus Service'}, but it did not answer through the cluster API or through a port forward. Check that its pod is running, or choose another Service.`,
    };
  }
  return {
    title: 'No Prometheus found',
    body: 'Charts need a Prometheus server in this cluster: a Service labelled app.kubernetes.io/name=prometheus, or one named prometheus-server, prometheus-operated or kube-prometheus-stack-prometheus. Install one, or choose its Service.',
  };
};

interface Props {
  request: ChartRequest;
}

/** The last hour of CPU, memory, network and filesystem for one pod, workload or node. */
export const PromCharts = ({ request }: Props) => {
  const view = useCharts(request);
  const [choose, setChoose] = useState(false);
  const reply = view.reply;

  const dialog = choose ? (
    <PromServiceDialog
      context={request.context}
      dir={request.dir}
      current={null}
      onSaved={() => view.reload()}
      onClose={() => setChoose(false)}
    />
  ) : null;

  let body;
  if (view.phase === 'loading' && !reply) {
    body = <div class="k8s-center"><Spinner label="Looking for Prometheus" /></div>;
  } else if (view.phase === 'error' && view.error) {
    body = <ErrorState error={view.error} context={request.context} onRetry={view.reload} />;
  } else if (reply && !reply.available) {
    const text = promMissingText({ reason: reply.reason });
    body = (
      <div class="k8s-pad">
        <Empty title={text.title} body={text.body} action={{ label: 'Choose service', onClick: () => setChoose(true) }} />
      </div>
    );
  } else if (reply) {
    body = (
      <div class="k8s-charts">
        <div class="k8s-charts-head sui-small">
          <span class="sui-muted">{`Last hour, 1 minute steps, from ${reply.service ?? 'Prometheus'}${reply.via === 'forward' ? ' (through a port forward)' : ''}`}</span>
          <span class="k8s-push">
            <Button label="Refresh" size="xs" variant="ghost" loading={view.phase === 'loading'} onClick={view.reload} />
          </span>
        </div>
        {reply.charts.map((chart) => <Chart chart={chart} />)}
      </div>
    );
  }
  return (
    <>
      {body}
      {dialog}
    </>
  );
};
