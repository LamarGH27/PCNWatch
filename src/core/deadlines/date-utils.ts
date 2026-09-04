/**
 * Calendar helpers for PCN deadlines.
 *
 * All dates are handled as plain calendar dates in UTC ("YYYY-MM-DD"). PCN
 * deadlines are calendar-day based, so time zones and DST must never enter the
 * calculation — using UTC midnight throughout removes an entire class of
 * off-by-one bugs around British Summer Time.
 */

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE.test(value)) return false;
  const d = parseIsoDate(value);
  return d !== null && toIsoDate(d) === value;
}

export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp);
}

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(date);
  if (!d) throw new RangeError(`Invalid ISO date: ${date}`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) throw new RangeError(`Invalid ISO date range: ${from} → ${to}`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday, in UTC. */
export function dayOfWeek(date: IsoDate): number {
  const d = parseIsoDate(date);
  if (!d) throw new RangeError(`Invalid ISO date: ${date}`);
  return d.getUTCDay();
}
