import { useEffect, useRef, useState } from 'preact/hooks';
import { call } from '../host.ts';
import { Button, Select, Spinner, TextField } from '../kit.tsx';

interface Props {
  context: string;
  dir: string | null;
  namespace: string;
  pod: string;
  containers: string[];
  onClose?: () => void;
}

interface Entry {
  kind: 'command' | 'out' | 'err' | 'note';
  text: string;
}

/** One command at a time, no TTY: the console for anything that prints and exits. */
export const ConsoleView = ({ context, dir, namespace, pod, containers, onClose }: Props) => {
  const [container, setContainer] = useState(containers[0] ?? '');
  const [command, setCommand] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const history = useRef<string[]>([]);
  const at = useRef(-1);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = outRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, running]);

  const run = async (): Promise<void> => {
    const text = command.trim();
    if (!text || running) return;
    history.current = [...history.current.filter((entry) => entry !== text), text].slice(-50);
    at.current = -1;
    setEntries((prev) => [...prev, { kind: 'command', text }]);
    setCommand('');
    setRunning(true);
    const reply = await call('POST', '/console', { context, dir, namespace, pod, container, command: text });
    setRunning(false);
    if (!reply.ok) {
      setEntries((prev) => [...prev, { kind: 'err', text: String(reply.error ?? 'The command did not run.') }]);
      return;
    }
    const out = String(reply.output ?? '');
    const err = String(reply.errorOutput ?? '');
    const code = Number(reply.code ?? 0);
    setEntries((prev) => [
      ...prev,
      ...(out ? [{ kind: 'out' as const, text: out.replace(/\n$/, '') }] : []),
      ...(err ? [{ kind: 'err' as const, text: err.replace(/\n$/, '') }] : []),
      ...(code !== 0 ? [{ kind: 'note' as const, text: `Exit code ${code}` }] : []),
    ]);
  };

  const step = (delta: number): void => {
    if (history.current.length === 0) return;
    const base = at.current < 0 ? history.current.length : at.current;
    const next = Math.min(history.current.length, Math.max(0, base + delta));
    at.current = next >= history.current.length ? -1 : next;
    setCommand(at.current < 0 ? '' : history.current[at.current] ?? '');
  };

  return (
    <div class="k8s-console">
      <div class="k8s-logs-head">
        <strong class="k8s-ellipsis">{`Console ${pod}`}</strong>
        {onClose ? <span class="k8s-push"><Button label="Close" size="xs" variant="ghost" onClick={onClose} /></span> : null}
      </div>
      <div class="k8s-logs-controls">
        {containers.length > 1 ? (
          <span class="k8s-logs-container">
            <Select value={container} options={containers.map((name) => ({ id: name, label: name }))} onChange={setContainer} placeholder="Container" />
          </span>
        ) : null}
        <span class="sui-muted sui-small">runs `sh -c` with no terminal, 30 s limit. Interactive programs (vi, top) need Copy shell command.</span>
      </div>
      <div class="k8s-console-out" ref={outRef}>
        {entries.length === 0 ? <div class="sui-muted sui-small">Try `ls -la`, `env` or `cat /etc/os-release`.</div> : null}
        {entries.map((entry) => (
          <pre class={`k8s-console-line k8s-console-line--${entry.kind} sui-mono`}>{entry.kind === 'command' ? `$ ${entry.text}` : entry.text}</pre>
        ))}
        {running ? <div class="k8s-console-line sui-muted sui-small">Running...</div> : null}
      </div>
      <div class="k8s-console-input" onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          step(-1);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          step(1);
        } else if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void run();
        }
      }}>
        <TextField value={command} onChange={setCommand} placeholder="Command in the container" mono disabled={running} />
        <Button label={running ? 'Running' : 'Run'} size="sm" onClick={() => void run()} disabled={running || !command.trim()} loading={running} />
        {running ? <Spinner size="sm" /> : null}
      </div>
    </div>
  );
};
