// Shell text the user pastes into OpenChamber's terminal. Every value is quoted, so a pod or context
// name with a space, a quote or a `$` cannot change the command.

/** A word safe for a POSIX shell: letters, digits and a few punctuation marks. */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Single-quotes a value for a POSIX shell, escaping embedded single quotes as '\''. */
export const shellQuote = (value: string): string => (SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The command that opens a shell in a running container. It prefers bash and falls back to sh. */
export const shellCommand = (context: string, namespace: string, pod: string, container?: string): string => {
  const parts = ['kubectl', '--context', shellQuote(context), '-n', shellQuote(namespace), 'exec', '-it', shellQuote(pod)];
  if (container) parts.push('-c', shellQuote(container));
  parts.push('--', 'sh', '-c', shellQuote('command -v bash >/dev/null && exec bash || exec sh'));
  return parts.join(' ');
};

/** The command that opens a debug container on a node. */
export const nodeShellCommand = (context: string, node: string): string =>
  `kubectl --context ${shellQuote(context)} debug node/${shellQuote(node)} -it --image=busybox`;

/** Copy for the shell command button. */
export const SHELL_COPIED = 'Copied. Paste it in OpenChamber\u2019s terminal.';
