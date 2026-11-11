import { createHash } from 'node:crypto';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalEntry {
  expiresAt: string;
  action: string;
  used: boolean;
}

export type ApprovalsFile = Record<string, ApprovalEntry>;

export interface ApprovalInput {
  context: string;
  namespace: string;
  verb: string;
  kind: string;
  name: string;
  /** The manifest or other body of the write. Empty when the verb has none. */
  payload?: string;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const escapeField = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/**
 * `sha256(context|namespace|verb|kind|name|sha256(payload))`: what the user approves is exactly what the retry runs.
 * A `|` or `\` inside a field is escaped, so no two different writes share a hash.
 */
export const approvalHash = (input: ApprovalInput): string =>
  sha256([input.context, input.namespace, input.verb, input.kind, input.name, sha256(input.payload ?? '')].map(escapeField).join('|'));

export const pruneApprovals = (file: ApprovalsFile, now: number): ApprovalsFile =>
  Object.fromEntries(Object.entries(file).filter(([, entry]) => !entry.used && Date.parse(entry.expiresAt) > now));

/** Records a click on Approve. Valid for 10 minutes and one use. */
export const grantApproval = (file: ApprovalsFile, hash: string, action: string, now: number): ApprovalsFile => ({
  ...pruneApprovals(file, now),
  [hash]: { expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(), action, used: false },
});

export interface UseResult {
  ok: boolean;
  file: ApprovalsFile;
}

/** Spends an approval. A second call with the same hash fails. */
export const useApproval = (file: ApprovalsFile, hash: string, now: number): UseResult => {
  const entry = file[hash];
  if (!entry || entry.used || Date.parse(entry.expiresAt) <= now) return { ok: false, file: pruneApprovals(file, now) };
  return { ok: true, file: { ...pruneApprovals(file, now), [hash]: { ...entry, used: true } } };
};
