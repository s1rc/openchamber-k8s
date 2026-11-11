import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyLocks, normalizeLocks, type LocksFile } from '../shared/locks.ts';
import type { ApprovalsFile } from '../shared/approval.ts';
import type { ProjectPick } from '../shared/types.ts';

/** Shared with the OpenCode plugin, outside the package so a write never reloads the extension. */
export const stateDir = (): string => process.env.K8S_STATE_DIR || join(homedir(), '.config', 'openchamber-k8s');

export const ensureDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A folder we do not own keeps its mode; the files inside are still 0600.
  }
  return dir;
};

export const readJson = <T>(name: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), name), 'utf8')) as T;
  } catch {
    return fallback;
  }
};

/** Write to a temp file, then rename, so a reader never sees half a file. */
export const writeJson = (name: string, value: unknown): void => {
  const dir = ensureDir(stateDir());
  const file = join(dir, name);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
};

export const updateJson = <T>(name: string, fallback: T, change: (current: T) => T): T => {
  const next = change(readJson(name, fallback));
  writeJson(name, next);
  return next;
};

export const readLocks = (): LocksFile => normalizeLocks(readJson<unknown>('locks.json', emptyLocks()));
export const writeLocks = (file: LocksFile): void => writeJson('locks.json', file);

export const readPicks = (): Record<string, ProjectPick> => readJson<Record<string, ProjectPick>>('projects.json', {});
export const writePick = (dir: string, pick: ProjectPick): void => {
  updateJson<Record<string, ProjectPick>>('projects.json', {}, (all) => ({ ...all, [dir]: pick }));
};

export const readApprovals = (): ApprovalsFile => readJson<ApprovalsFile>('approvals.json', {});
export const writeApprovals = (file: ApprovalsFile): void => writeJson('approvals.json', file);

export interface AuditEntry {
  project: string | null;
  context: string;
  verb: string;
  target: string;
  source: 'panel' | 'agent';
}

/** One JSON line per real write. Never holds a manifest or a Secret value. */
export const appendAudit = (entry: AuditEntry): void => {
  const dir = ensureDir(stateDir());
  appendFileSync(join(dir, 'audit.log'), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
};

export const sockDir = (): string => ensureDir(join(ensureDir(stateDir()), 'sock'));
