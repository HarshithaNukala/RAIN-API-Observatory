import { describe, expect, it } from 'vitest';
import { missedIntervals, nextScheduledCheckAt } from './schedule.js';

const t = (iso: string) => new Date(`2026-11-18T${iso}Z`);

describe('nextScheduledCheckAt', () => {
  it('is one interval after the scheduled time when the check ran on time', () => {
    expect(nextScheduledCheckAt(t('10:00:00'), 60, t('10:00:00.400'))).toEqual(t('10:01:00'));
  });

  it('does not drift when the check ran late within the interval', () => {
    // Scheduled 10:00, finished 10:00:45: the cadence stays on the minute.
    expect(nextScheduledCheckAt(t('10:00:00'), 60, t('10:00:45'))).toEqual(t('10:01:00'));
  });

  it('skips missed intervals instead of replaying them', () => {
    // Worker was down from 10:00 to 10:07:30: one check now, the next on the 10:08 slot.
    expect(nextScheduledCheckAt(t('10:00:00'), 60, t('10:07:30'))).toEqual(t('10:08:00'));
    expect(missedIntervals(t('10:00:00'), 60, t('10:07:30'))).toBe(7);
  });

  it('never returns a time at or before now', () => {
    // Exactly on a slot boundary: that slot is "now", so the next one is chosen.
    expect(nextScheduledCheckAt(t('10:00:00'), 60, t('10:02:00'))).toEqual(t('10:03:00'));
  });

  it('is one interval ahead when the schedule is still in the future', () => {
    expect(nextScheduledCheckAt(t('10:05:00'), 300, t('10:00:00'))).toEqual(t('10:10:00'));
    expect(missedIntervals(t('10:05:00'), 300, t('10:00:00'))).toBe(0);
  });

  it.each([0, -5, 1.5, Number.NaN])('rejects interval %s', (interval) => {
    expect(() => nextScheduledCheckAt(t('10:00:00'), interval, t('10:00:00'))).toThrow(RangeError);
  });
});
