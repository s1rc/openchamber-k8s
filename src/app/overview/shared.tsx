import type { ComponentChildren } from 'preact';
import { Dot } from '@openchamber-ext/shared-ui/preact';
import { ageText, clipText } from '../../shared/format.ts';
import type { WarningEvent } from '../../shared/overview.ts';
import { ErrorState, type ErrorInfo } from '../errors.tsx';
import { Button, Empty, Spinner } from '../kit.tsx';
import type { Live, WatchView } from '../useWatch.ts';

/** One state for the header dot: the worst of the live views the overview holds. */
export const combineLive = (lives: Live[]): Live => {
  for (const state of ['offline', 'reconnecting', 'connecting'] as const) if (lives.includes(state)) return state;
  return 'live';
};

/** Errors that only affect one card. Every other error stops the whole overview and offers Try again. */
const INLINE = new Set(['FORBIDDEN', 'NOT_FOUND', 'NO_CONTEXT']);

export const blockingError = (views: WatchView[]): ErrorInfo | null => {
  for (const view of views) if (view.phase === 'error' && view.error && !INLINE.has(view.error.code)) return view.error;
  return null;
};

export const isForbidden = (view: WatchView): boolean => view.phase === 'error' && view.error?.code === 'FORBIDDEN';

interface FrameProps {
  title: string;
  layout: 'page' | 'rail';
  /** Rail layout: the section picker. */
  lead?: ComponentChildren;
  note?: string;
  children: ComponentChildren;
}

/** The toolbar and scroll area both overviews sit in, matching the resource views. */
export const OverviewFrame = ({ title, layout, lead, note, children }: FrameProps) =>
  layout === 'rail' ? (
    <div class="k8s-resource k8s-resource--rail">
      <div class="k8s-toolbar k8s-toolbar--rail">
        {lead}
        <strong>{title}</strong>
        {note ? <span class="sui-muted sui-small">{note}</span> : null}
      </div>
      <div class="k8s-scroll"><div class="k8s-ov">{children}</div></div>
    </div>
  ) : (
    <div class="k8s-resource">
      <div class="k8s-resource-main">
        <div class="k8s-toolbar">
          <h2 class="k8s-title">{title}</h2>
          {note ? <span class="sui-muted sui-small">{note}</span> : null}
        </div>
        <div class="k8s-scroll"><div class="k8s-ov">{children}</div></div>
      </div>
    </div>
  );

export const OverviewLoading = ({ label }: { label: string }) => <div class="k8s-center"><Spinner label={label} /></div>;

export const OverviewError = ({ error, context, onRetry }: { error: ErrorInfo; context: string; onRetry: () => void }) => <ErrorState error={error} context={context} onRetry={onRetry} />;

export const NoAccess = ({ what }: { what: string }) => <Empty title={`No access to ${what}`} body={`Your account may not list ${what.toLowerCase()} here. The rest of the overview still works.`} />;

interface WarningsProps {
  events: WarningEvent[];
  total: number;
  now: number;
  loading: boolean;
  onAll: () => void;
}

/** The newest Warning events, a few lines each. */
export const WarningList = ({ events, total, now, loading, onAll }: WarningsProps) => {
  if (loading) return <OverviewLoading label="Loading events" />;
  if (events.length === 0) return <div class="sui-muted sui-small">No warnings. Events older than an hour are gone from the cluster.</div>;
  return (
    <div class="k8s-warnings">
      {events.map((event) => (
        <div class="k8s-warning" key={event.key}>
          <div class="k8s-warning-head sui-small">
            <Dot tone="warning" />
            <strong>{event.reason || 'Warning'}</strong>
            <span class="sui-mono k8s-ellipsis" title={event.object}>{event.object}</span>
            <span class="sui-muted k8s-push">{`${event.count > 1 ? `${event.count}x · ` : ''}${ageText(event.at, now)}`}</span>
          </div>
          <div class="k8s-wrap sui-small" title={event.message}>{clipText(event.message, 220)}</div>
          {event.namespace ? <div class="sui-muted sui-small">{event.namespace}</div> : null}
        </div>
      ))}
      <div class="k8s-warnings-foot sui-small">
        <span class="sui-muted">{total > events.length ? `Showing ${events.length} of ${total}.` : ''}</span>
        <span class="k8s-push"><Button label="All events" size="xs" variant="ghost" onClick={onAll} /></span>
      </div>
    </div>
  );
};
