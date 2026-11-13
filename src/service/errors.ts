export type ErrorCode =
  | 'NO_KUBECTL'
  | 'AUTH_EXPIRED'
  | 'FORBIDDEN'
  | 'UNREACHABLE'
  | 'LOCKED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID'
  | 'BAD_REQUEST'
  | 'NO_CONTEXT'
  | 'UNKNOWN_WATCH'
  | 'K8S_ERROR'
  | 'INTERNAL';

export interface ErrorAction {
  kind: 'sign-in' | 'unlock' | 'install';
  context?: string;
  /** For a sign-in that is about an AWS profile and not a cluster (the EKS discovery). */
  profile?: string;
}

export class K8sError extends Error {
  readonly code: ErrorCode;
  readonly action?: ErrorAction;
  /** The HTTP status of the cluster's answer, when the error came from one. */
  status?: number;
  constructor(code: ErrorCode, message: string, action?: ErrorAction) {
    super(message);
    this.code = code;
    if (action) this.action = action;
  }
}

const MISSING_PROGRAM = /executable .* not found|exec: .*not found|not found in \$path|command not found/i;
const AUTH =
  /token has expired|sso session.*(expired|invalid)|unauthorizedssotokenerror|error loading sso token|sso.*(login|expired)|expiredtoken|unable to locate credentials|getting credentials|invalid_grant|failed to refresh|you must be logged in|provide credentials|unauthorized|oidc-login|kubelogin/i;
const UNREACHABLE =
  /dial tcp|i\/o timeout|no such host|connection refused|network is unreachable|deadline exceeded|tls handshake timeout|client\.timeout|connection reset|no route to host|unable to connect to the server|unexpected eof/i;

export const clip = (text: string, max = 300): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

/**
 * Text from a program that is shown in the panel: no access key id, no link (a sign-in link is single use), no token
 * (a JWT, or any long unbroken run of letters and digits).
 */
export const scrub = (text: string): string =>
  text
    .replace(/\b(AKIA|ASIA|AIDA|AROA)[0-9A-Z]{12,}\b/g, '<key id>')
    .replace(/https?:\/\/\S+/g, '<link>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*){0,2}/g, '<token>')
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '<redacted>');

/** Reads kubectl, aws or proxy output and says what kind of failure it is, or null when unclear. */
export const classifyText = (text: string): ErrorCode | null => {
  if (MISSING_PROGRAM.test(text)) return 'NO_KUBECTL';
  if (AUTH.test(text)) return 'AUTH_EXPIRED';
  if (UNREACHABLE.test(text)) return 'UNREACHABLE';
  return null;
};

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  NO_KUBECTL: 'A program the cluster connection needs was not found. Install it and try again.',
  AUTH_EXPIRED: 'Your sign-in for this cluster has expired.',
  UNREACHABLE: 'The cluster is not reachable. Check your network or VPN.',
};

/** Builds the error for a Kubernetes API answer that was not a success. */
export const fromHttp = (status: number, body: string, context?: string): K8sError => {
  const error = fromHttpInner(status, body, context);
  error.status = status;
  return error;
};

const fromHttpInner = (status: number, body: string, context?: string): K8sError => {
  let message = '';
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') message = parsed.message;
  } catch {
    message = body;
  }
  const signIn = context ? ({ kind: 'sign-in', context } as const) : undefined;
  if (status === 401) return new K8sError('AUTH_EXPIRED', MESSAGES.AUTH_EXPIRED as string, signIn);
  if (status === 403) return new K8sError('FORBIDDEN', clip(message) || 'You are not allowed to do that here.');
  if (status === 404) return new K8sError('NOT_FOUND', clip(message) || 'Not found.');
  if (status === 409) return new K8sError('CONFLICT', clip(message) || 'The resource changed or conflicts. Reload and try again.');
  if (status === 400 || status === 422) return new K8sError('INVALID', clip(message) || 'The cluster refused that change.');
  const code = classifyText(`${message} ${body}`);
  if (code === 'AUTH_EXPIRED') return new K8sError(code, MESSAGES.AUTH_EXPIRED as string, signIn);
  if (code) return new K8sError(code, MESSAGES[code] ?? clip(message));
  return new K8sError('K8S_ERROR', clip(message) || `The cluster answered ${status}.`);
};

/** From program output (stderr) to an error. */
export const fromOutput = (output: string, fallback: string, context?: string): K8sError => {
  const code = classifyText(output);
  if (code === 'AUTH_EXPIRED') return new K8sError(code, MESSAGES.AUTH_EXPIRED as string, context ? { kind: 'sign-in', context } : undefined);
  if (code === 'NO_KUBECTL') return new K8sError(code, MESSAGES.NO_KUBECTL as string, { kind: 'install' });
  if (code) return new K8sError(code, MESSAGES[code] ?? fallback);
  return new K8sError('K8S_ERROR', clip(output) || fallback);
};

export interface ErrorReply {
  ok: false;
  code: ErrorCode;
  error: string;
  action?: ErrorAction;
}

export const toReply = (error: unknown): ErrorReply => {
  if (error instanceof K8sError) return { ok: false, code: error.code, error: error.message, ...(error.action ? { action: error.action } : {}) };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: 'INTERNAL', error: clip(message) || 'Something went wrong.' };
};
