/**
 * A loggable summary of an error: the innermost cause's name, code and message. Drizzle wraps
 * driver errors as "Failed query: <SQL> params: <values>", so that wrapper's message (and any
 * message that echoes a query) is never logged; the driver's own cause says what went wrong.
 */
export function safeError(err: unknown): { name?: string; code?: string; message: string } {
  let innermost: unknown = err;
  let code: string | undefined;
  for (let depth = 0; depth < 6 && innermost instanceof Error; depth++) {
    const own = (innermost as { code?: unknown }).code;
    if (typeof own === 'string') code = own;
    const { cause } = innermost as { cause?: unknown };
    if (!(cause instanceof Error)) break;
    innermost = cause;
  }
  if (!(innermost instanceof Error)) return { message: 'Unknown error' };
  const message = /failed query|params:/i.test(innermost.message)
    ? 'Database query failed'
    : innermost.message.slice(0, 300);
  return { name: innermost.name, ...(code && { code }), message };
}

/** True when an error (or any cause) is a database query error that may carry SQL parameters. */
export function isQueryError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (/failed query|params:/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
