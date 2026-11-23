import { performance } from 'node:perf_hooks';
import {
  CHECK_ERROR_MESSAGE_MAX_LENGTH,
  MONITOR_LIMITS,
  MonitorHeaderUpsertSchema,
  findMonitorUrlIssue,
  sanitizeUrlForLog,
  type MonitorMethod,
  type NoResponseReason,
} from '@rain/shared';
import { request, type Dispatcher } from 'undici';
import { DecryptionError, type SealedSecret, type SecretBox } from '../crypto/secret-box.js';
import type { MonitorHeaderRow, MonitorRow } from '../db/schema.js';
import { bodyContext, headerContext } from '../monitors/secret-contexts.js';
import { classifyCheck, type CheckResult } from './health.js';
import {
  createSafeDispatcher,
  isSafeDispatcher,
  type SafeConnectorOptions,
} from './safe-transport.js';

/**
 * HTTP monitoring executor: turns one monitor configuration into one classified check.
 *
 * SECURITY BOUNDARY: SSRF protection lives in the transport (safe-transport.ts), which validates
 * and pins every connection. The executor only ever sends through the transport it is given, never
 * through undici's global dispatcher, and in EVERY environment it accepts only a dispatcher built
 * by `createSafeDispatcher`; anything else (a plain Agent, a MockAgent) is refused before a request
 * is made. Runtime code obtains its transport from `createProductionTransport()`: the safe
 * transport, or `OUTBOUND_DISABLED` if that can't be built. Tests reach local servers through the
 * same safe dispatcher (test-support/local-target.ts). See docs/security/monitor-network-security.md.
 */

export const EXECUTOR_LIMITS = {
  /** Largest request body the executor will send. */
  requestBodyMaxBytes: MONITOR_LIMITS.requestBodyMaxBytes,
  timeoutMs: { min: 1000, max: 30_000 },
  /** Response bytes read (and discarded) before the connection is closed. */
  responseBodyMaxBytes: 64 * 1024,
} as const;

/** Identifies RAIN to monitored servers. A user-configured User-Agent header takes precedence. */
export const DEFAULT_USER_AGENT = 'RAIN-API-Observatory/0.1 (uptime monitor)';

const SAFE_METHODS: ReadonlySet<MonitorMethod> = new Set(['GET', 'HEAD', 'OPTIONS']);
const MUTATING_METHODS: ReadonlySet<MonitorMethod> = new Set(['POST', 'PUT', 'PATCH']);

/** Where requests go. A `dispatcher` transport must hold the SSRF-safe dispatcher. */
export type MonitorTransport =
  { kind: 'disabled'; reason: string } | { kind: 'dispatcher'; dispatcher: Dispatcher };

export const OUTBOUND_DISABLED: MonitorTransport = {
  kind: 'disabled',
  reason: 'Outbound monitoring requests are disabled because no SSRF-safe transport is configured.',
};

/** The SSRF-safe transport: DNS-validated, IP-pinned, TLS-verified connections. */
export function createSafeTransport(options: SafeConnectorOptions = {}): MonitorTransport {
  return { kind: 'dispatcher', dispatcher: createSafeDispatcher(options) };
}

/**
 * The transport production code must use: the safe transport, or a transport that refuses every
 * request if the safe one cannot be built. There is no fallback to an unvalidated client.
 */
export function createProductionTransport(
  build: () => MonitorTransport = () => createSafeTransport(),
): MonitorTransport {
  try {
    const transport = build();
    return transport.kind === 'dispatcher' && isSafeDispatcher(transport.dispatcher)
      ? transport
      : OUTBOUND_DISABLED;
  } catch {
    return OUTBOUND_DISABLED;
  }
}

/** A monitor as the executor needs it: secrets still encrypted until the moment of sending. */
export interface ExecutableMonitor {
  id: string;
  url: string;
  method: MonitorMethod;
  expectedStatusCode: number;
  timeoutMs: number;
  latencyThresholdMs: number;
  requestBody: SealedSecret | null;
  bodyContentType: string | null;
  headers: Array<{ name: string; value: SealedSecret }>;
  /**
   * The owner's persisted consent (`monitors.allow_mutating_requests`). POST, PUT and PATCH are
   * only sent when this is true.
   */
  allowMutatingRequests: boolean;
}

export function executableMonitorFrom(
  row: MonitorRow,
  headers: MonitorHeaderRow[],
): ExecutableMonitor {
  const hasBody =
    row.requestBodyCiphertext !== null &&
    row.requestBodyIv !== null &&
    row.requestBodyAuthTag !== null &&
    row.requestBodyKeyVersion !== null;
  return {
    id: row.id,
    url: row.url,
    method: row.method as MonitorMethod,
    expectedStatusCode: row.expectedStatusCode,
    timeoutMs: row.timeoutMs,
    latencyThresholdMs: row.latencyThresholdMs,
    requestBody: hasBody
      ? {
          ciphertext: row.requestBodyCiphertext!,
          iv: row.requestBodyIv!,
          authTag: row.requestBodyAuthTag!,
          keyVersion: row.requestBodyKeyVersion!,
        }
      : null,
    bodyContentType: row.bodyContentType,
    allowMutatingRequests: row.allowMutatingRequests,
    headers: headers.map((h) => ({
      name: h.headerName,
      value: {
        ciphertext: h.valueCiphertext,
        iv: h.valueIv,
        authTag: h.valueAuthTag,
        keyVersion: h.encryptionKeyVersion,
      },
    })),
  };
}

/**
 * Why a check was not attempted. These are configuration or policy problems, not evidence about
 * the target's health, so no check result is produced and nothing is sent.
 */
export type ExecutionRefusalCode =
  | 'OUTBOUND_DISABLED'
  | 'UNSUPPORTED_METHOD'
  | 'MUTATING_METHOD_NOT_ACKNOWLEDGED'
  | 'INVALID_TIMEOUT'
  | 'INVALID_DESTINATION'
  | 'INVALID_HEADER'
  | 'REQUEST_BODY_TOO_LARGE'
  | 'SECRET_UNAVAILABLE';

export class ExecutionRefusedError extends Error {
  constructor(
    readonly code: ExecutionRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionRefusedError';
  }
}

export interface CheckExecution {
  /** Wall-clock time the check started, for `monitor_checks.checked_at`. */
  checkedAt: Date;
  result: CheckResult;
  /** Sanitised, user-safe explanation for failures; NULL for passing checks. */
  errorMessage: string | null;
  /**
   * About the response body, which is read only up to a limit, discarded, and then cancelled.
   * `bodyLimitReached`: reading stopped at the limit (more data may have existed, unread).
   */
  response: { bodyBytesRead: number; bodyLimitReached: boolean } | null;
}

/**
 * The check to record when the executor refused to send: no request was made, so there is no
 * status and no latency. A destination refused by the URL rules counts as BLOCKED_DESTINATION;
 * every other refusal is CONFIGURATION_ERROR. Both reasons are health-neutral (they describe
 * RAIN's rules, not the target), so recording them never moves the monitor towards DOWN.
 */
export function refusedExecution(
  monitor: Pick<ExecutableMonitor, 'method' | 'url' | 'expectedStatusCode' | 'latencyThresholdMs'>,
  err: ExecutionRefusedError,
  checkedAt: Date,
): CheckExecution {
  const reason: NoResponseReason =
    err.code === 'INVALID_DESTINATION' ? 'BLOCKED_DESTINATION' : 'CONFIGURATION_ERROR';
  const target = `${monitor.method} ${sanitizeUrlForLog(monitor.url)}`;
  return {
    checkedAt,
    result: classifyCheck({ kind: 'no-response', reason }, monitor),
    // Refusal messages are fixed texts (plus a header name at most); never a secret value.
    errorMessage: `${target}: check not sent. ${err.message}`.slice(
      0,
      CHECK_ERROR_MESSAGE_MAX_LENGTH,
    ),
    response: null,
  };
}

export interface MonitorExecutorDependencies {
  transport: MonitorTransport;
  secretBox: SecretBox;
  /** Monotonic milliseconds, for latency. Defaults to `performance.now`. */
  monotonicNow?: () => number;
  /** Wall clock, for `checkedAt`. */
  now?: () => Date;
  userAgent?: string;
}

export interface MonitorExecutor {
  execute(monitor: ExecutableMonitor): Promise<CheckExecution>;
}

const utf8Length = (value: string) => Buffer.byteLength(value, 'utf8');

/** Collects `code` values through an error's `cause` chain (undici wraps socket errors). */
function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
    const { code, cause, name } = current as { code?: unknown; cause?: unknown; name?: unknown };
    if (typeof code === 'string') codes.push(code);
    if (typeof name === 'string') codes.push(name);
    current = cause;
  }
  return codes;
}

const DNS_CODES = new Set([
  'ENOTFOUND',
  'ENODATA',
  'ETIMEOUT',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EAI_FAIL',
  'EAI_NODATA',
]);
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'ETIMEDOUT', 'TimeoutError']);
const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|CERT_)|^(UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|HOSTNAME_MISMATCH)/;

/** Maps a transport error to a no-response reason. Never looks at the error's message text. */
export function noResponseReason(err: unknown, timedOut: boolean): NoResponseReason {
  // The SSRF guard's refusal wins over everything, including a timer that fired meanwhile.
  if (errorCodes(err).includes('ERR_RAIN_BLOCKED_DESTINATION')) return 'BLOCKED_DESTINATION';
  if (timedOut) return 'TIMEOUT';
  const codes = errorCodes(err);
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return 'TIMEOUT';
  if (codes.some((c) => DNS_CODES.has(c))) return 'DNS_ERROR';
  if (codes.some((c) => TLS_CODE.test(c))) return 'TLS_ERROR';
  if (codes.some((c) => CONNECTION_CODES.has(c))) return 'CONNECTION_ERROR';
  return 'REQUEST_ERROR';
}

/** Fixed, safe wording per reason: the target is shown without query string or credentials. */
function noResponseMessage(reason: NoResponseReason, target: string, timeoutMs: number): string {
  switch (reason) {
    case 'TIMEOUT':
      return `${target}: no response within ${timeoutMs} ms`;
    case 'DNS_ERROR':
      return `${target}: the host name could not be resolved`;
    case 'CONNECTION_ERROR':
      return `${target}: the connection failed or was closed`;
    case 'TLS_ERROR':
      return `${target}: TLS handshake or certificate verification failed`;
    case 'BLOCKED_DESTINATION':
      return `${target}: the destination is not allowed`;
    case 'REQUEST_ERROR':
      return `${target}: the request could not be completed`;
    case 'CONFIGURATION_ERROR':
      return `${target}: the check was not sent because of the monitor's configuration`;
  }
}

/**
 * Reads and discards a response body, consuming at most `limit` bytes, then cancels it.
 *
 * - As soon as the limit is reached, no further chunk is requested, not even to find out whether
 *   more data exists, and the stream is destroyed (cancelling the response).
 * - If a chunk crosses the limit, only the bytes up to the limit are counted as consumed; the rest
 *   of that chunk is dropped unexamined.
 * - Chunks are counted and dropped, never collected.
 *
 * `bodyLimitReached` therefore means "reading stopped at the limit": the body may or may not have
 * had more data, which is deliberately not checked.
 */
export async function drainResponseBody(
  body: AsyncIterable<unknown> & { destroyed: boolean; destroy(): void },
  limit: number = EXECUTOR_LIMITS.responseBodyMaxBytes,
): Promise<{ bodyBytesRead: number; bodyLimitReached: boolean }> {
  let bodyBytesRead = 0;
  let bodyLimitReached = limit <= 0;
  try {
    if (!bodyLimitReached) {
      for await (const chunk of body) {
        const remaining = limit - bodyBytesRead;
        const size = (chunk as Buffer).length;
        if (size >= remaining) {
          bodyBytesRead = limit;
          bodyLimitReached = true;
          break; // Stop here: the next chunk is never requested.
        }
        bodyBytesRead += size;
      }
    }
  } catch {
    // A body that fails after the headers arrived doesn't change the result.
  } finally {
    if (!body.destroyed) body.destroy();
  }
  return { bodyBytesRead, bodyLimitReached };
}

export function createMonitorExecutor(deps: MonitorExecutorDependencies): MonitorExecutor {
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const now = deps.now ?? (() => new Date());
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;

  /** Everything that can be decided without touching secrets or the network. */
  function checkConfiguration(monitor: ExecutableMonitor): Dispatcher {
    if (deps.transport.kind !== 'dispatcher') {
      throw new ExecutionRefusedError('OUTBOUND_DISABLED', deps.transport.reason);
    }
    // In every environment, including tests: there is no way to send through anything else.
    if (!isSafeDispatcher(deps.transport.dispatcher)) {
      throw new ExecutionRefusedError(
        'OUTBOUND_DISABLED',
        'Outbound monitoring requests require the SSRF-safe transport',
      );
    }
    if (!SAFE_METHODS.has(monitor.method) && !MUTATING_METHODS.has(monitor.method)) {
      throw new ExecutionRefusedError('UNSUPPORTED_METHOD', `Unsupported method ${monitor.method}`);
    }
    // Only the persisted owner consent counts; a missing or non-boolean value is a refusal.
    if (MUTATING_METHODS.has(monitor.method) && monitor.allowMutatingRequests !== true) {
      throw new ExecutionRefusedError(
        'MUTATING_METHOD_NOT_ACKNOWLEDGED',
        `${monitor.method} checks are only sent when repeated mutating requests are explicitly permitted`,
      );
    }
    const { min, max } = EXECUTOR_LIMITS.timeoutMs;
    if (
      !Number.isInteger(monitor.timeoutMs) ||
      monitor.timeoutMs < min ||
      monitor.timeoutMs > max
    ) {
      throw new ExecutionRefusedError(
        'INVALID_TIMEOUT',
        `Timeout must be between ${min} and ${max} ms`,
      );
    }
    // Syntax-level destination rules again (scheme, literal private IPs, ports). This is not
    // SSRF protection: connection-time DNS validation is the transport's job (Phase 3.3).
    const urlIssue = findMonitorUrlIssue(monitor.url);
    if (urlIssue) {
      throw new ExecutionRefusedError(
        'INVALID_DESTINATION',
        `Destination rejected: ${urlIssue.message}`,
      );
    }
    if (monitor.requestBody && !MUTATING_METHODS.has(monitor.method)) {
      throw new ExecutionRefusedError(
        'UNSUPPORTED_METHOD',
        `${monitor.method} requests can't send a body`,
      );
    }
    return deps.transport.dispatcher;
  }

  /** Decrypts secrets for this one request. Values never leave the returned object. */
  function prepareRequest(monitor: ExecutableMonitor) {
    let body: string | null = null;
    const headers: Record<string, string> = {};
    try {
      for (const header of monitor.headers) {
        const value = deps.secretBox.decrypt(header.value, headerContext(monitor.id, header.name));
        // Re-validate the stored header before it goes on the wire (no CR/LF, no reserved names).
        if (!MonitorHeaderUpsertSchema.safeParse({ name: header.name, value }).success) {
          throw new ExecutionRefusedError('INVALID_HEADER', `Header "${header.name}" is not valid`);
        }
        headers[header.name.toLowerCase()] = value;
      }
      if (monitor.requestBody) {
        body = deps.secretBox.decrypt(monitor.requestBody, bodyContext(monitor.id));
      }
    } catch (err) {
      if (err instanceof DecryptionError) {
        throw new ExecutionRefusedError(
          'SECRET_UNAVAILABLE',
          'A stored header or request body could not be decrypted',
        );
      }
      throw err;
    }

    if (body !== null) {
      if (utf8Length(body) > EXECUTOR_LIMITS.requestBodyMaxBytes) {
        throw new ExecutionRefusedError(
          'REQUEST_BODY_TOO_LARGE',
          `Request bodies are limited to ${EXECUTOR_LIMITS.requestBodyMaxBytes / 1024} KB`,
        );
      }
      headers['content-type'] = monitor.bodyContentType ?? 'application/json';
    }
    headers['user-agent'] ??= userAgent;
    return { headers, body };
  }

  return {
    async execute(monitor) {
      const dispatcher = checkConfiguration(monitor);
      const { headers, body } = prepareRequest(monitor);
      const target = `${monitor.method} ${sanitizeUrlForLog(monitor.url)}`;
      const criteria = {
        expectedStatusCode: monitor.expectedStatusCode,
        latencyThresholdMs: monitor.latencyThresholdMs,
      };

      const checkedAt = now();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, monitor.timeoutMs);
      const started = monotonicNow();

      try {
        let response: Dispatcher.ResponseData;
        try {
          response = await request(monitor.url, {
            dispatcher,
            method: monitor.method,
            headers,
            body,
            signal: controller.signal,
            headersTimeout: monitor.timeoutMs,
            bodyTimeout: monitor.timeoutMs,
            // undici closes the socket after every HEAD response by default; on some platforms
            // that races into a TCP reset reported as a failed check (~10–15% on Windows
            // loopback in testing). Keeping the connection open avoids false CONNECTION_ERRORs.
            ...(monitor.method === 'HEAD' && { reset: false }),
          });
        } catch (err) {
          const reason = noResponseReason(err, timedOut);
          return {
            checkedAt,
            result: classifyCheck({ kind: 'no-response', reason }, criteria),
            errorMessage: noResponseMessage(reason, target, monitor.timeoutMs),
            response: null,
          };
        }

        // Latency is time to response headers; the body is not part of it.
        const latencyMs = Math.max(0, monotonicNow() - started);
        const result = classifyCheck(
          { kind: 'response', statusCode: response.statusCode, latencyMs },
          criteria,
        );
        const bodyInfo = await drainResponseBody(response.body);
        return {
          checkedAt,
          result,
          errorMessage:
            result.outcome === 'FAILURE'
              ? `${target}: expected status ${monitor.expectedStatusCode}, received ${response.statusCode}`
              : null,
          response: bodyInfo,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
