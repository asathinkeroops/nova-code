/**
 * Schedule parsing and next-fire computation for cron entries. Pure and
 * dependency-free (no `cron-parser`/`luxon`) — the repo values minimal deps, and
 * a 5-field parser plus a bounded next-fire scan is small and fully testable.
 *
 * Two schedule flavours share one entry:
 *   - interval: `30s`/`5m`/`1h` — the grammar `/loop` has always used.
 *   - cron: a standard 5-field expression `minute hour dom month dow`.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const UNITS = { s: SECOND, m: MINUTE, h: HOUR } as const;

/**
 * Parse a human interval like `30s`, `5m`, `1h` into milliseconds. Returns null
 * for anything that isn't a positive integer followed by a single s/m/h unit —
 * callers surface a usage error. A bare number (no unit) is rejected on purpose
 * so `5 ...` can't silently mean 5ms.
 */
export function parseDuration(input: string): number | null {
  const m = /^(\d+)(s|m|h)$/.exec(input.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * UNITS[m[2] as keyof typeof UNITS];
}

/** Render a millisecond interval back to the compact `Ns`/`Nm`/`Nh` form for cards. */
export function formatDuration(ms: number): string {
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / SECOND)}s`;
}

export type ScheduleSpec =
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; expr: string };

/**
 * A parsed 5-field cron expression. Each field is the concrete set of matching
 * values; `domRestricted`/`dowRestricted` record whether the day-of-month /
 * day-of-week field was `*` so `nextCronFire` can apply the POSIX OR-rule.
 */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldRange {
  min: number;
  max: number;
  /** Normalize day-of-week 7 → 0 (both mean Sunday). */
  dow?: boolean;
}

/**
 * Parse one cron field into the set of matching values within [min, max]. A field
 * is a comma list of tokens; each token is `*`, a number `N`, a range `A-B`, or
 * any of those with a `/step` suffix. Returns null on malformed/out-of-range input.
 */
function parseField(raw: string, range: FieldRange): Set<number> | null {
  const out = new Set<number>();
  const norm = (n: number): number => (range.dow && n === 7 ? 0 : n);
  for (const part of raw.split(",")) {
    if (part === "") return null;
    const [spec, stepStr] = part.split("/") as [string, string | undefined];
    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr)) return null;
      step = Number.parseInt(stepStr, 10);
      if (step <= 0) return null;
    }

    let lo: number;
    let hi: number;
    if (spec === "*") {
      lo = range.min;
      hi = range.max;
    } else if (/^\d+$/.test(spec)) {
      lo = hi = norm(Number.parseInt(spec, 10));
      // A bare number with a step (e.g. `5/10`) ranges from the number up.
      if (stepStr !== undefined) hi = range.max;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(spec);
      if (!m) return null;
      lo = norm(Number.parseInt(m[1]!, 10));
      hi = norm(Number.parseInt(m[2]!, 10));
    }

    if (lo < range.min || hi > range.max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6, dow: true }, // day of week (0=Sun; 7 normalized to 0)
];

/**
 * Parse a standard 5-field cron expression `minute hour dom month dow`. Returns
 * null if the shape is wrong or any field is malformed/out-of-range.
 */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, FIELD_RANGES[i]!));
  if (sets.some((s) => s === null)) return null;
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow: sets[4]!,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/**
 * Decide whether a token is an interval or a cron expression. `30s`/`5m`/`1h` →
 * interval; a valid 5-field expression → cron; anything else → null. The `/loop`
 * command only ever passes an interval token, so its behavior is unchanged.
 */
export function parseSchedule(input: string): ScheduleSpec | null {
  const trimmed = input.trim();
  const intervalMs = parseDuration(trimmed);
  if (intervalMs !== null) return { kind: "interval", intervalMs };
  const fields = parseCron(trimmed);
  if (fields) return { kind: "cron", expr: trimmed.split(/\s+/).join(" ") };
  return null;
}

/** Upper bound on the next-fire scan: a year of minutes. Guards impossible exprs. */
const HORIZON_MS = 366 * 24 * HOUR;

/**
 * Compute the next fire strictly after `from` (epoch ms) for a parsed cron
 * expression, scanning minute-by-minute in local time. Returns null when nothing
 * matches within a year (e.g. `0 0 30 2 *` — Feb 30 never exists).
 *
 * Day matching follows the POSIX rule: when both day-of-month and day-of-week are
 * restricted, a day matches if *either* does; when only one is restricted, only
 * that one constrains; when neither is, every day matches.
 */
export function nextCronFire(fields: CronFields, from: number): number | null {
  // First candidate is the start of the next whole minute after `from`.
  const start = (Math.floor(from / MINUTE) + 1) * MINUTE;
  const end = start + HORIZON_MS;
  for (let t = start; t < end; t += MINUTE) {
    const d = new Date(t);
    if (!fields.minute.has(d.getMinutes())) continue;
    if (!fields.hour.has(d.getHours())) continue;
    if (!fields.month.has(d.getMonth() + 1)) continue;
    const domMatch = fields.dom.has(d.getDate());
    const dowMatch = fields.dow.has(d.getDay());
    const dayMatch =
      fields.domRestricted && fields.dowRestricted
        ? domMatch || dowMatch
        : fields.domRestricted
          ? domMatch
          : fields.dowRestricted
            ? dowMatch
            : true;
    if (dayMatch) return t;
  }
  return null;
}
