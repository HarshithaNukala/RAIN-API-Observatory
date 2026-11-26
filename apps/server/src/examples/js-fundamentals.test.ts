import { describe, expect, it } from 'vitest';
import {
  demonstrateFunctionHoisting,
  fetchStepWithCallback,
  fetchStepWithPromise,
  runPromisePipeline,
} from './js-fundamentals.js';

describe('JavaScript fundamentals (isolated educational examples)', () => {
  it('demonstrates function declaration hoisting vs let/const TDZ and var hoisting', () => {
    expect(demonstrateFunctionHoisting(21)).toEqual({
      hoistedResult: 42,
      tdzErrorName: 'ReferenceError',
      varBeforeAssignment: 'undefined',
    });
  });

  it('demonstrates callbacks vs Promises and async/await', async () => {
    const callbackResult = await new Promise<number>((resolve, reject) => {
      fetchStepWithCallback(5, false, (err, value) => {
        if (err) reject(err);
        else resolve(value!);
      });
    });
    expect(callbackResult).toBe(15);

    await expect(fetchStepWithPromise(5, false)).resolves.toBe(15);
    await expect(fetchStepWithPromise(5, true)).rejects.toThrow('Promise step failed');
    await expect(runPromisePipeline(5)).resolves.toBe(25);
  });
});
