import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), 'bin')];

/** PATH with the usual install folders appended, for the service and every child it starts. */
export const extendedPath = (base: string | undefined = process.env.PATH): string => {
  const parts = (base ?? '').split(':').filter(Boolean);
  for (const dir of EXTRA_DIRS) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(':');
};

export const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: extendedPath() });

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Absolute path of a program, searched on the extended PATH. `null` when missing. */
export const findBin = (name: string): string | null => {
  for (const dir of extendedPath().split(':')) {
    const file = join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
};
