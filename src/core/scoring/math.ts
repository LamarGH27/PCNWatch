/** Deterministic numeric helpers used by the Ticket Activity Score. */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Midrank percentile of `value` within `population`, in [0,1].
 *
 * Midrank (average rank for ties) is used rather than "fraction strictly below"
 * so that a population of identical values yields 0.5 for every member instead of
 * 0 — which would otherwise make an entire uniform borough read as "Very Low".
 *
 * Deterministic: depends only on the multiset of values, not on ordering.
 */
export function midrankPercentile(value: number, population: readonly number[]): number {
  if (population.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const p of population) {
    if (p < value) below += 1;
    else if (p === value) equal += 1;
  }
  return clamp01((below + equal / 2) / population.length);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Empirical-Bayes style shrinkage toward a prior.
 *
 * With `n` observations and pseudo-count `k`, the observed value carries weight
 * n/(n+k). This is what stops "1 PCN last month, 3 this month = +200% trend"
 * from dominating a score.
 */
export function shrinkToward(observed: number, prior: number, n: number, k: number): number {
  if (k <= 0) return observed;
  const w = n / (n + k);
  return prior + (observed - prior) * w;
}

/**
 * Exponential recency weight for a bucket that is `monthsAgo` months old.
 * `halfLifeMonths` months ago counts for half of "now".
 */
export function recencyWeight(monthsAgo: number, halfLifeMonths: number): number {
  if (halfLifeMonths <= 0) return monthsAgo === 0 ? 1 : 0;
  if (monthsAgo < 0) return 1;
  return Math.pow(0.5, monthsAgo / halfLifeMonths);
}

/** Whole months between two UTC ISO dates, floored at 0. Deterministic, no locale. */
export function monthsBetween(earlierIso: string, laterIso: string): number {
  const a = new Date(`${earlierIso.slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${laterIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.max(0, months);
}

/** Round to a fixed number of decimals without floating-point drift surprises. */
export function round(value: number, decimals = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
