import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Dot } from '@openchamber-ext/shared-ui/preact';
import { stripAnsi } from '../../shared/format.ts';
import { podSpecOf } from '../../shared/kinds.ts';
import type { Obj } from '../../shared/types.ts';
import { host } from '../host.ts';
import { Button, Select, SearchField, Spinner, Switch } from '../kit.tsx';
import { LOG_CAP, podsFor, useLogs, type LogTarget } from '../useLogs.ts';

interface Props {
  context: string;
  dir: string | null;
  namespace: string;
  object: Obj;
  /** Rail layout: a Close button instead of nothing. */
  onClose?: () => void;
}

const containersOf = (object: Obj): string[] => {
  const spec = podSpecOf(object);
  return Array.isArray(spec?.containers) ? (spec.containers as Obj[]).map((container) => String(container.name)) : [];
};

const Highlight = ({ text, needle }: { text: string; needle: string }): ComponentChildren => {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const wanted = needle.toLowerCase();
  const parts: ComponentChildren[] = [];
  let at = 0;
  let found = lower.indexOf(wanted);
  let guard = 0;
  while (found >= 0 && guard < 200) {
    if (found > at) parts.push(text.slice(at, found));
    parts.push(<mark class="k8s-mark">{text.slice(found, found + needle.length)}</mark>);
    at = found + needle.length;
    found = lower.indexOf(wanted, at);
    guard += 1;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
};

/** Follows one pod or every pod of a workload, with the controls the plan lists. */
export const LogView = ({ context, dir, namespace, object, onClose }: Props) => {
  const kind = String(object.kind ?? '');
  const name = String(object.metadata?.name ?? '');
  const [targets, setTargets] = useState<LogTarget[]>(() => (kind === 'Pod' ? [{ pod: name, containers: containersOf(object) }] : []));
  const [loadingPods, setLoadingPods] = useState(kind !== 'Pod');
  const [container, setContainer] = useState<string | null>(null);
  const [previous, setPrevious] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const containerOptions = useMemo(() => {
    const all = [...new Set(targets.flatMap((target) => target.containers))];
    return all.map((entry) => ({ id: entry, label: entry }));
  }, [targets]);

  useEffect(() => {
    if (kind === 'Pod') {
      setTargets([{ pod: name, containers: containersOf(object) }]);
      setLoadingPods(false);
      return;
    }
    setLoadingPods(true);
    setTargets([]);
    let cancelled = false;
    void podsFor(object, context, dir, namespace).then((found) => {
      if (cancelled) return;
      setTargets(found);
      setLoadingPods(false);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, name, context, dir, namespace]);

  const logs = useLogs(loadingPods ? null : targets, { context, dir, namespace, container, previous, timestamps });

  useEffect(() => {
    follow.current = true;
  }, [targets.length, container, previous, timestamps]);

  useEffect(() => {
    const node = logRef.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [logs.lines.length]);

  const needle = query.trim();
  const copy = async (): Promise<void> => {
    const text = logs.lines.map((line) => (targets.length > 1 ? `${line.pod} ${stripAnsi(line.text)}` : stripAnsi(line.text))).join('\n');
    await host.writeClipboard(text.slice(0, 31_000));
  };

  const state = logs.state;
  const tone = state === 'live' ? 'success' : state === 'error' ? 'error' : state === 'ended' ? 'muted' : 'info';
  const stateLabel = state === 'live' ? 'Following' : state === 'error' ? 'Stopped' : state === 'ended' ? 'Ended' : 'Connecting';
  const more = targets.length >= 10 ? 'Showing the first 10 pods.' : '';

  return (
    <div class="k8s-logs">
      <div class="k8s-logs-head">
        <strong class="k8s-ellipsis">{`${kind}/${name}`}</strong>
        {targets.length > 1 ? <span class="sui-muted sui-small">{`${targets.length} pods`}</span> : null}
        <span class="k8s-logs-state sui-small">
          <Dot tone={tone} />
          <span class="sui-muted">{stateLabel}</span>
        </span>
        {onClose ? <span class="k8s-push"><Button label="Close" size="xs" variant="ghost" onClick={onClose} /></span> : null}
      </div>
      <div class="k8s-logs-controls">
        {containerOptions.length > 1 ? (
          <span class="k8s-logs-container">
            <Select
              value={container ?? containerOptions[0]?.id ?? ''}
              options={containerOptions}
              onChange={(id) => setContainer(id)}
              placeholder="Container"
            />
          </span>
        ) : null}
        <Switch label="Previous" checked={previous} onChange={(checked) => setPrevious(checked)} description="Logs of the last crashed container" />
        <Switch label="Timestamps" checked={timestamps} onChange={(checked) => setTimestamps(checked)} />
        <Switch label="Wrap" checked={wrap} onChange={(checked) => setWrap(checked)} />
        <span class="k8s-logs-search"><SearchField value={query} onChange={setQuery} placeholder="Search logs" /></span>
        <Button label="Copy" size="xs" variant="outline" onClick={() => void copy()} disabled={logs.lines.length === 0} />
        <Button label="Clear" size="xs" variant="ghost" onClick={logs.clear} disabled={logs.lines.length === 0} />
      </div>
      {more ? <div class="sui-muted sui-small k8s-logs-note">{more}</div> : null}
      {logs.error ? <div class="k8s-logs-note sui-small">{logs.error}</div> : null}
      <div class={`k8s-log${wrap ? ' k8s-log--wrap' : ''}`} ref={logRef} onScroll={(event) => {
        const node = event.currentTarget as HTMLDivElement;
        follow.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
      }}>
        {loadingPods || (state === 'connecting' && logs.lines.length === 0) ? (
          <div class="k8s-center"><Spinner label="Opening the logs" /></div>
        ) : logs.lines.length === 0 ? (
          <div class="k8s-log-empty sui-muted">{state === 'ended' ? 'This container printed nothing.' : 'No lines yet.'}</div>
        ) : (
          logs.lines.map((line) => (
            <div class="k8s-log-line" key={line.n}>
              {targets.length > 1 ? <span class="k8s-log-pod sui-muted sui-mono">{line.pod}</span> : null}
              <span class="k8s-log-text sui-mono"><Highlight text={stripAnsi(line.text)} needle={needle} /></span>
            </div>
          ))
        )}
        {logs.lines.length >= LOG_CAP ? <div class="k8s-logs-note sui-muted sui-small">{`Only the last ${LOG_CAP} lines are kept.`}</div> : null}
      </div>
    </div>
  );
};
