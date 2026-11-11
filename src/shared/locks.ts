export interface LocksFile {
  /** Per-context override of the production guess. */
  protected: Record<string, boolean>;
  /** Context to the ISO time its unlock ends. */
  unlocked: Record<string, string>;
}

export const UNLOCK_MS = 30 * 60 * 1000;

export const emptyLocks = (): LocksFile => ({ protected: {}, unlocked: {} });

export const normalizeLocks = (value: unknown): LocksFile => {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<LocksFile>;
  return {
    protected: raw.protected && typeof raw.protected === 'object' ? { ...raw.protected } : {},
    unlocked: raw.unlocked && typeof raw.unlocked === 'object' ? { ...raw.unlocked } : {},
  };
};

/** The guess: a context is protected when its name or cluster ARN says prod. */
export const guessProtected = (name: string, arn?: string | null): boolean => /prod/i.test(name) || (arn ? /prod/i.test(arn) : false);

export const isProtected = (file: LocksFile, name: string, arn?: string | null): boolean => {
  const override = file.protected[name];
  return typeof override === 'boolean' ? override : guessProtected(name, arn);
};

/** Epoch ms when the unlock ends, or null when the context is not unlocked right now. */
export const unlockedUntil = (file: LocksFile, name: string, now: number): number | null => {
  const iso = file.unlocked[name];
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now ? at : null;
};

/** Writes are refused when the context is protected and not unlocked. */
export const isLocked = (file: LocksFile, name: string, arn: string | null | undefined, now: number): boolean =>
  isProtected(file, name, arn) && unlockedUntil(file, name, now) === null;

export const unlock = (file: LocksFile, name: string, now: number, ms = UNLOCK_MS): LocksFile => ({
  ...file,
  unlocked: { ...pruneExpired(file, now).unlocked, [name]: new Date(now + ms).toISOString() },
});

export const lock = (file: LocksFile, name: string): LocksFile => {
  const { [name]: _gone, ...rest } = file.unlocked;
  return { ...file, unlocked: rest };
};

export const setProtected = (file: LocksFile, name: string, value: boolean): LocksFile => ({
  protected: { ...file.protected, [name]: value },
  unlocked: value ? file.unlocked : lock(file, name).unlocked,
});

export const pruneExpired = (file: LocksFile, now: number): LocksFile => ({
  ...file,
  unlocked: Object.fromEntries(Object.entries(file.unlocked).filter(([, iso]) => Date.parse(iso) > now)),
});
