/**
 * Date windows for the operator dashboard, anchored to Europe/London.
 *
 * The dashboard reads two systems that do not share a clock. Supabase stores
 * `timestamptz`, and the Vercel Web Analytics API takes an explicit range. If
 * each half picked its own day boundary the two would disagree by up to an hour
 * across a BST change and by a whole day either side of midnight — and the
 * disagreement would look like a conversion-rate movement rather than a bug.
 *
 * So a window is resolved once, here, as a pair of UTC instants, and the same
 * two instants are handed to both. "Today" means the London day, because that
 * is the day the operator is having.
 *
 * No timezone library: `Intl` already carries the IANA database, including the
 * BST transition dates, and a lookup table of those transitions is exactly the
 * kind of thing that is correct until the year it is not.
 */

export type WindowKey = 'TODAY' | 'LAST_7' | 'LAST_30';

export const WINDOW_KEYS: readonly WindowKey[] = ['TODAY', 'LAST_7', 'LAST_30'];

export const WINDOW_LABELS: Readonly<Record<WindowKey, string>> = {
  TODAY: 'Today',
  LAST_7: 'Last 7 days',
  LAST_30: 'Last 30 days',
};

/** How many London days each window spans, today included. */
const WINDOW_DAYS: Readonly<Record<WindowKey, number>> = {
  TODAY: 1,
  LAST_7: 7,
  LAST_30: 30,
};

export interface DateWindow {
  readonly key: WindowKey;
  readonly label: string;
  /** Inclusive start: the first instant of the first London day in range. */
  readonly startUtc: Date;
  /** Exclusive end: "now". A window never reports a future it cannot have. */
  readonly endUtc: Date;
  /** How many London days the window spans, today included. */
  readonly days: number;
}

const TIME_ZONE = 'Europe/London';

const FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface LondonParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function londonParts(instant: Date): LondonParts {
  const parts = FORMATTER.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * How far ahead of UTC London is at a given instant: +0 in winter, +1h in BST.
 *
 * Derived by formatting the instant in London, reading that wall-clock time
 * back as though it were UTC, and taking the difference.
 */
function londonOffsetMs(instant: Date): number {
  const p = londonParts(instant);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Whole seconds on both sides, so the sub-second part of `instant` must go.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which a given London calendar day begins.
 *
 * Solved rather than calculated, because the offset depends on the answer: at
 * the spring transition the offset an hour before midnight differs from the one
 * an hour after. The first pass guesses using the offset at a reference instant
 * and the second re-reads the offset at the guess, which is the actual one
 * unless a transition falls inside that hour. Britain's transitions happen at
 * 01:00 UTC, never at midnight, so the second pass settles it.
 */
function startOfLondonDayUtc(year: number, month: number, day: number, reference: Date): Date {
  const wallClock = Date.UTC(year, month - 1, day);
  let instant = wallClock - londonOffsetMs(reference);
  instant = wallClock - londonOffsetMs(new Date(instant));
  return new Date(instant);
}

/** The London calendar day `daysAgo` days before the London day containing `now`. */
function londonDayStart(now: Date, daysAgo: number): Date {
  const today = londonParts(now);
  const startOfToday = startOfLondonDayUtc(today.year, today.month, today.day, now);
  if (daysAgo === 0) return startOfToday;

  /*
   * Stepped back in UTC, then re-resolved to a London midnight.
   *
   * Subtracting whole days from a UTC instant lands somewhere inside the target
   * London day but not necessarily at its start — an hour out, either way,
   * across a transition. Reading the London date off that instant and asking
   * for the beginning of *that* day removes the drift, and is why this cannot
   * simply subtract `daysAgo * 86_400_000` and stop.
   */
  const inTargetDay = new Date(startOfToday.getTime() - daysAgo * 86_400_000 + 43_200_000);
  const target = londonParts(inTargetDay);
  return startOfLondonDayUtc(target.year, target.month, target.day, inTargetDay);
}

/** Resolves a window key into the pair of instants both data sources will use. */
export function resolveWindow(key: WindowKey, now: Date = new Date()): DateWindow {
  const days = WINDOW_DAYS[key];
  return {
    key,
    label: WINDOW_LABELS[key],
    startUtc: londonDayStart(now, days - 1),
    endUtc: now,
    days,
  };
}

/** Parses the `?range=` parameter. Anything unrecognised falls back to today. */
export function parseWindowKey(raw: string | undefined): WindowKey {
  return WINDOW_KEYS.find((key) => key === raw) ?? 'TODAY';
}

/** The London calendar dates a window covers, oldest first, as `YYYY-MM-DD`. */
export function londonDaysInWindow(window: DateWindow): string[] {
  const dates: string[] = [];
  for (let offset = window.days - 1; offset >= 0; offset -= 1) {
    const start = londonDayStart(window.endUtc, offset);
    const parts = londonParts(new Date(start.getTime() + 43_200_000));
    dates.push(
      `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    );
  }
  return dates;
}
