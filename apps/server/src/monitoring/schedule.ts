/**
 * Scheduling arithmetic for the worker. Pure: no clock, no database.
 *
 * A monitor's cadence is anchored to its schedule, not to when checks happen to finish:
 * the next check is `scheduledAt + k × interval` for the smallest k ≥ 1 that lies in the future.
 * - A check that ran late does not push the cadence back (no drift).
 * - Intervals missed while the worker was down or overloaded are skipped, not replayed: one check
 *   runs, and the next is the first slot after now.
 */
export function nextScheduledCheckAt(scheduledAt: Date, intervalSeconds: number, now: Date): Date {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new RangeError(
      `interval must be a positive whole number of seconds, got ${intervalSeconds}`,
    );
  }
  const step = intervalSeconds * 1000;
  const behind = now.getTime() - scheduledAt.getTime();
  const slots = behind < 0 ? 1 : Math.floor(behind / step) + 1;
  return new Date(scheduledAt.getTime() + slots * step);
}

/** Intervals skipped because they were already in the past when the check completed. */
export function missedIntervals(scheduledAt: Date, intervalSeconds: number, now: Date): number {
  const behind = now.getTime() - scheduledAt.getTime();
  return behind < 0 ? 0 : Math.floor(behind / (intervalSeconds * 1000));
}
