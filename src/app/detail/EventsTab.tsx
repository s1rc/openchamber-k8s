import { useEffect, useState } from 'preact/hooks';
import { Dot } from '@openchamber-ext/shared-ui/preact';
import { ageText } from '../../shared/format.ts';
import { eventTime } from '../../shared/kinds.ts';
import type { Obj } from '../../shared/types.ts';
import { ErrorState, type ErrorInfo } from '../errors.tsx';
import { call, notify } from '../host.ts';
import { Button, Empty, Spinner } from '../kit.tsx';

interface Props {
  context: string;
  dir: string | null;
  object: Obj;
  now: number;
}

type State = { phase: 'loading' } | { phase: 'ready'; events: Obj[] } | { phase: 'error'; error: ErrorInfo };

const MAX_SHOWN = 100;

/** The events about one resource. Loaded when the tab opens and again on Refresh, never on a timer. */
export const EventsTab = ({ context, dir, object, now }: Props) => {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const namespace = object.metadata?.namespace as string | undefined;
  const name = String(object.metadata?.name ?? '');
  const kind = String(object.kind ?? '');

  const load = async (fromClick: boolean): Promise<void> => {
    const reply = await call('GET', '/list', {
      context,
      dir,
      kind: 'Event',
      namespace: namespace ?? '_all',
      fieldSelector: `involvedObject.kind=${kind},involvedObject.name=${name}`,
    });
    if (reply.ok) {
      const events = [...(reply.items as Obj[])].sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0));
      setState({ phase: 'ready', events });
      return;
    }
    if (fromClick) notify('error', String(reply.error ?? 'Could not load events.'));
    else setState({ phase: 'error', error: { code: String(reply.code ?? 'INTERNAL'), message: reply.error } });
  };

  useEffect(() => {
    setState({ phase: 'loading' });
    void load(false);
  }, [context, namespace, name, kind]);

  if (state.phase === 'loading') return <div class="k8s-center"><Spinner label="Loading events" /></div>;
  if (state.phase === 'error') return <ErrorState error={state.error} context={context} onRetry={() => void load(false)} />;
  return (
    <div class="k8s-events">
      <div class="sui-row">
        <span class="sui-muted sui-small sui-grow">{state.events.length === 1 ? '1 event' : `${state.events.length} events`}</span>
        <Button label="Refresh" size="xs" variant="outline" onClick={() => void load(true)} />
      </div>
      {state.events.length === 0 ? (
        <Empty title="No events" body="Kubernetes keeps events for about an hour, so an older resource may have none." />
      ) : (
        state.events.slice(0, MAX_SHOWN).map((event) => (
          <div class="k8s-event">
            <div class="sui-row">
              <Dot tone={event.type === 'Warning' ? 'warning' : 'info'} />
              <strong>{String(event.reason ?? '')}</strong>
              {Number(event.count ?? 1) > 1 ? <span class="sui-muted sui-small">{`x${String(event.count)}`}</span> : null}
              <span class="sui-muted sui-small k8s-push">{ageText(eventTime(event), now)}</span>
            </div>
            <div class="k8s-wrap sui-small">{String(event.message ?? '')}</div>
          </div>
        ))
      )}
    </div>
  );
};
