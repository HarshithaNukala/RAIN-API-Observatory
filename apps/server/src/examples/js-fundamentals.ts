/**
 * Isolated educational examples for Kalvium assessment concepts #11 (JavaScript Hoisting) and
 * #12 (Promises vs Callbacks). Production RAIN business logic does NOT import this module; it
 * exists solely as a self-contained, executable demonstration covered by unit tests.
 */

/**
 * Concept #11 — JavaScript Hoisting
 *
 * Function declarations are hoisted with their body during the creation phase, so they can be
 * invoked before their lexical position in the same scope.
 *
 * By contrast:
 * - `let` and `const` bindings are hoisted only as uninitialized slots in the Temporal Dead Zone
 *   (TDZ): reading them before initialization throws a `ReferenceError`.
 * - `var` declarations are hoisted and initialized to `undefined` across the entire enclosing
 *   function scope (ignoring block scope), which is error-prone and forbidden in production RAIN
 *   code via ESLint `no-var`.
 */
export function demonstrateFunctionHoisting(input: number): {
  hoistedResult: number;
  tdzErrorName: string;
  varBeforeAssignment: string;
} {
  // Function declaration invoked BEFORE its definition below: works because of hoisting.
  const hoistedResult = doubleValue(input);

  // `let` / `const` TDZ demonstration via an inner block.
  let tdzErrorName = 'none';
  {
    const readInTdz = () => tempValue;
    try {
      readInTdz();
    } catch (err) {
      tdzErrorName = err instanceof Error ? err.name : 'unknown';
    }
    const tempValue = 'initialized';
    void tempValue;
  }

  // `var` hoisting demonstration (isolated here with explicit ESLint waiver).
  function inspectVarHoisting(): string {
    // eslint-disable-next-line no-var
    var readBeforeInit = () => typeof legacyVar;
    const beforeAssignment = readBeforeInit();
    // eslint-disable-next-line no-var
    var legacyVar = 'assigned-later';
    void legacyVar;
    return beforeAssignment; // 'undefined', not ReferenceError
  }

  return {
    hoistedResult,
    tdzErrorName,
    varBeforeAssignment: inspectVarHoisting(),
  };

  function doubleValue(n: number): number {
    return n * 2;
  }
}

/**
 * Concept #12 — Promises vs Callbacks
 *
 * Error-first callbacks were Node's original async pattern, but composing sequential steps leads
 * to nested callback pyramids and fragmented error handling. Promises (and `async`/`await`)
 * represent future values cleanly, propagate rejections through `try/catch`, and compose
 * concurrently with `Promise.all` / `Promise.allSettled` — which is why RAIN uses `async`/`await`
 * across PostgreSQL queries, MongoDB CRUD, Gemini requests, and the monitoring worker.
 */
export function fetchStepWithCallback(
  value: number,
  shouldFail: boolean,
  cb: (err: Error | null, result?: number) => void,
): void {
  queueMicrotask(() => {
    if (shouldFail) {
      cb(new Error('Callback step failed'));
      return;
    }
    cb(null, value + 10);
  });
}

export async function fetchStepWithPromise(value: number, shouldFail: boolean): Promise<number> {
  await Promise.resolve();
  if (shouldFail) {
    throw new Error('Promise step failed');
  }
  return value + 10;
}

export async function runPromisePipeline(seed: number): Promise<number> {
  const first = await fetchStepWithPromise(seed, false);
  const second = await fetchStepWithPromise(first, false);
  return second;
}
