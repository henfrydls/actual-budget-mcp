/**
 * The span searched when asking whether a write landed.
 *
 * Not the single day it was written for. Actual runs rules on every insert and
 * a rule can move the date, so looking only at the intended day turns "a rule
 * moved it" into "it was never saved" — and that answer authorises the retry
 * that duplicates. The old category-enforcement code already warned on stderr
 * that the SDK may normalise a date outside the queried window; this stops
 * treating that case as certainty.
 *
 * A month either side covers date rules in practice and costs one query. It is
 * not a proof: a rule could set any date at all, which is why "nothing new
 * here" is reported together with the window it looked in, so the claim can be
 * checked rather than taken on trust.
 */
export const PROBE_DAYS = 31;

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function probeWindow(date: string): { start: string; end: string; label: string } {
  const start = shift(date, -PROBE_DAYS);
  const end = shift(date, PROBE_DAYS);
  return { start, end, label: `searched ${start} to ${end}` };
}
