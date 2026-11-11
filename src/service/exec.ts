import { execFile } from 'node:child_process';
import { childEnv, findBin } from './bins.ts';
import { K8sError } from './errors.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const run = (file: string, args: string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = execFile(file, args, { env: childEnv(), timeout: options.timeoutMs ?? 30000, maxBuffer: options.maxBuffer ?? 16_000_000 }, (error, stdout, stderr) => {
      const exit = (error as { code?: unknown } | null)?.code;
      resolve({ code: error ? (typeof exit === 'number' ? exit : -1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });

export const kubectlPath = (): string => {
  const found = findBin('kubectl');
  if (!found) throw new K8sError('NO_KUBECTL', 'kubectl was not found. Install it, for example with Homebrew.', { kind: 'install' });
  return found;
};

export const kubeconfigArgs = (kubeconfig?: string): string[] => (kubeconfig ? ['--kubeconfig', kubeconfig] : []);
