// Small text helpers shared by the kind registry and the panel. No DOM, so they run in tests.

/** kubectl-style age: `45s`, `5m12s`, `3h20m`, `12d`, `2y30d`. */
export const ageText = (fromMs: number | null | undefined, now: number): string => {
  if (fromMs === null || fromMs === undefined || !Number.isFinite(fromMs)) return '';
  const total = Math.max(0, Math.floor((now - fromMs) / 1000));
  if (total < 120) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 10) return `${minutes}m${total % 60 || ''}${total % 60 ? 's' : ''}`;
  if (minutes < 180) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 8) return `${hours}h${minutes % 60 || ''}${minutes % 60 ? 'm' : ''}`;
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 8) return `${days}d${hours % 24 || ''}${hours % 24 ? 'h' : ''}`;
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y${days % 365 || ''}${days % 365 ? 'd' : ''}`;
};

const BYTE_UNITS: Record<string, number> = {
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** Parses a Kubernetes quantity (`500m`, `2`, `128974848`, `129e6`, `1Gi`) to a number, or null. `m` means thousandths. */
export const parseQuantity = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(m|[kKMGTPE]i?)?$/.exec(value.trim());
  if (!match) return null;
  const base = Number(match[1]);
  const unit = match[2] ?? '';
  if (unit === 'm') return base / 1000;
  const factor = BYTE_UNITS[unit];
  return factor === undefined ? null : base * factor;
};

/** `15.4 GiB`, `512 MiB`, `0 B`. */
export const bytesText = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let at = 0;
  while (Math.abs(value) >= 1024 && at < units.length - 1) {
    value /= 1024;
    at += 1;
  }
  const digits = at === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[at]}`;
};

/** CPU cores, e.g. `1.93` or `4`. */
export const coresText = (cores: number | null | undefined): string => (cores === null || cores === undefined ? '' : String(Number(cores.toFixed(2))));

/** A string cut to `max` characters, with `...` when it was cut. */
export const clipText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
