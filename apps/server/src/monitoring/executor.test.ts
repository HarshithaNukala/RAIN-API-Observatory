import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { MONITOR_LIMITS, type MonitorMethod } from '@rain/shared';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretBox, type SecretBox } from '../crypto/secret-box.js';
import { bodyContext, headerContext } from '../monitors/secret-contexts.js';
import { startLocalTarget, type LocalTarget } from '../test-support/local-target.js';
import {
  EXECUTOR_LIMITS,
  ExecutionRefusedError,
  OUTBOUND_DISABLED,
  createMonitorExecutor,
  drainResponseBody,
  executableMonitorFrom,
  noResponseReason,
  type ExecutableMonitor,
  type MonitorTransport,
} from './executor.js';

// Every request goes through the real SSRF-safe dispatcher to a local test server.

// Plain HTTP to the local target; TLS is covered by safe-transport.test.ts.
const ORIGIN = 'http://api.example.com';
const SECRET = 'Bearer sk_live_executor-secret-9f8e';
const BODY = '{"probe":true,"token":"body-secret-77"}';
const box = createSecretBox({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });

function monitor(
  overrides: Partial<ExecutableMonitor> & { body?: string } = {},
): ExecutableMonitor {
  const id = overrides.id ?? randomUUID();
  const { body, ...rest } = overrides;
  return {
    id,
    url: `${ORIGIN}/health`,
    method: 'GET',
    expectedStatusCode: 200,
    timeoutMs: 5000,
    latencyThresholdMs: 500,
    requestBody: body === undefined ? null : box.encrypt(body, bodyContext(id)),
    bodyContentType: null,
    headers: [],
    // As for every existing monitor: no consent unless a test grants it.
    allowMutatingRequests: false,
    ...rest,
  };
}

const sealedHeader = (monitorId: string, name: string, value: string) => ({
  name,
  value: box.encrypt(value, headerContext(monitorId, name)),
});

let targets: LocalTarget[] = [];
afterEach(async () => {
  await Promise.all(targets.map((t) => t.close()));
  targets = [];
});

/**
 * An executor wired to the real SSRF-safe dispatcher, whose validated connections are diverted to
 * a local test server (test-support/local-target.ts). `agent.pendingInterceptors()` lists the
 * responses that were registered but never requested.
 */
async function setup(options: { latency?: [number, number]; secretBox?: SecretBox } = {}) {
  const target = await startLocalTarget();
  targets.push(target);
  const [start, end] = options.latency ?? [1000, 1120];
  const monotonicNow = vi.fn<() => number>().mockReturnValueOnce(start).mockReturnValue(end);
  const checkedAt = new Date('2026-11-17T12:00:00.000Z');
  const executor = createMonitorExecutor({
    transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
    secretBox: options.secretBox ?? box,
    monotonicNow,
    now: () => checkedAt,
  });
  const agent = { pendingInterceptors: () => Array.from({ length: target.pendingRoutes() }) };
  return {
    agent,
    target,
    executor,
    captured: target.captured,
    reply: target.reply,
    monotonicNow,
    checkedAt,
  };
}

describe('supported methods', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'] as const)(
    'sends %s without acknowledgement',
    async (method) => {
      const { executor, reply, captured } = await setup();
      reply('/health', method, 200);
      const execution = await executor.execute(monitor({ method }));
      expect(captured).toEqual([expect.objectContaining({ method, path: '/health' })]);
      expect(execution.result).toEqual({
        outcome: 'SUCCESS',
        statusCode: 200,
        latencyMs: 120,
        failureReason: null,
      });
      expect(execution.errorMessage).toBeNull();
    },
  );

  it.each(['POST', 'PUT', 'PATCH'] as const)(
    'sends %s with its body and content type when the owner permitted mutating requests',
    async (method) => {
      const { executor, reply, captured } = await setup();
      reply('/health', method, 200);
      const m = monitor({
        method,
        body: BODY,
        bodyContentType: 'application/vnd.rain+json',
        allowMutatingRequests: true,
      });
      const execution = await executor.execute(m);

      expect(execution.result.outcome).toBe('SUCCESS');
      expect(captured).toEqual([
        expect.objectContaining({
          method,
          body: BODY,
          headers: expect.objectContaining({ 'content-type': 'application/vnd.rain+json' }),
        }),
      ]);
    },
  );

  it('defaults the content type of a body to application/json', async () => {
    const { executor, reply, captured } = await setup();
    reply('/health', 'POST', 201);
    await executor.execute(
      monitor({ method: 'POST', body: BODY, expectedStatusCode: 201, allowMutatingRequests: true }),
    );
    expect(captured[0]?.headers['content-type']).toBe('application/json');
  });
});

describe('refusals (nothing is sent)', () => {
  it.each(['POST', 'PUT', 'PATCH'] as const)(
    'refuses %s unless the persisted permission is true, before decrypting anything',
    async (method: MonitorMethod) => {
      const decrypt = vi.fn(box.decrypt);
      const { executor, reply, agent } = await setup({ secretBox: { ...box, decrypt } });
      reply('/health', method, 200);

      // false (the default for every existing monitor) and malformed values are all refusals.
      for (const allowMutatingRequests of [false, undefined, 'true', 1]) {
        const m = monitor({ method, body: BODY });
        (m as { allowMutatingRequests: unknown }).allowMutatingRequests = allowMutatingRequests;
        await expect(executor.execute(m)).rejects.toMatchObject({
          name: 'ExecutionRefusedError',
          code: 'MUTATING_METHOD_NOT_ACKNOWLEDGED',
        });
      }
      expect(agent.pendingInterceptors()).toHaveLength(1);
      expect(decrypt).not.toHaveBeenCalled();
    },
  );

  it('ignores the permission for GET, HEAD and OPTIONS, which never mutate', async () => {
    const { executor, reply } = await setup();
    reply('/health', 'GET', 200);
    const execution = await executor.execute(monitor({ allowMutatingRequests: false }));
    expect(execution.result.outcome).toBe('SUCCESS');
  });

  it('reads the permission from the stored monitor row, defaulting to refusal', () => {
    const row = {
      id: randomUUID(),
      url: `${ORIGIN}/items`,
      method: 'POST',
      expectedStatusCode: 201,
      timeoutMs: 5000,
      latencyThresholdMs: 500,
      requestBodyCiphertext: null,
      requestBodyIv: null,
      requestBodyAuthTag: null,
      requestBodyKeyVersion: null,
      bodyContentType: null,
    };
    for (const allowMutatingRequests of [false, true]) {
      const executable = executableMonitorFrom(
        { ...row, allowMutatingRequests } as Parameters<typeof executableMonitorFrom>[0],
        [],
      );
      expect(executable.allowMutatingRequests).toBe(allowMutatingRequests);
    }
  });

  it('refuses everything when outbound requests are disabled (the production default)', async () => {
    const decrypt = vi.fn(box.decrypt);
    const executor = createMonitorExecutor({
      transport: OUTBOUND_DISABLED,
      secretBox: { ...box, decrypt },
    });
    const m = monitor();
    m.headers = [sealedHeader(m.id, 'Authorization', SECRET)];
    await expect(executor.execute(m)).rejects.toMatchObject({ code: 'OUTBOUND_DISABLED' });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it(`refuses a request body over ${EXECUTOR_LIMITS.requestBodyMaxBytes / 1024} KB`, async () => {
    const { executor, reply, agent } = await setup();
    reply('/health', 'POST', 200);
    const exactly = 'x'.repeat(EXECUTOR_LIMITS.requestBodyMaxBytes);
    const allowed = { method: 'POST' as const, allowMutatingRequests: true };
    await expect(executor.execute(monitor({ ...allowed, body: exactly }))).resolves.toMatchObject({
      result: { outcome: 'SUCCESS' },
    });

    reply('/health', 'POST', 200);
    await expect(
      executor.execute(monitor({ ...allowed, body: `${exactly}x` })),
    ).rejects.toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' });
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it('uses the same 32 KB limit as monitor creation and editing', () => {
    expect(EXECUTOR_LIMITS.requestBodyMaxBytes).toBe(MONITOR_LIMITS.requestBodyMaxBytes);
    expect(EXECUTOR_LIMITS.requestBodyMaxBytes).toBe(32 * 1024);
  });

  it('counts the body limit in UTF-8 bytes, not characters', async () => {
    const { executor } = await setup();
    const accented = 'é'.repeat(EXECUTOR_LIMITS.requestBodyMaxBytes / 2 + 1);
    await expect(
      executor.execute(monitor({ method: 'PUT', body: accented, allowMutatingRequests: true })),
    ).rejects.toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' });
  });

  it.each([999, 30_001, 1500.5])('refuses a timeout of %s ms', async (timeoutMs) => {
    const { executor } = await setup();
    await expect(executor.execute(monitor({ timeoutMs }))).rejects.toMatchObject({
      code: 'INVALID_TIMEOUT',
    });
  });

  it.each([
    ['a private address', 'http://10.0.0.5/health'],
    ['a custom port', 'https://api.example.com:8443/health'],
    ['a non-HTTP scheme', 'ftp://files.example.com/'],
  ])('re-checks the destination syntax and refuses %s', async (_label, url) => {
    const { executor } = await setup();
    await expect(executor.execute(monitor({ url }))).rejects.toMatchObject({
      code: 'INVALID_DESTINATION',
    });
  });

  it('refuses when a stored secret cannot be decrypted, without saying why', async () => {
    const { executor, reply, agent } = await setup();
    reply('/health', 'GET', 200);
    const m = monitor();
    // Sealed for another monitor: authentication fails under this monitor's context.
    m.headers = [sealedHeader(randomUUID(), 'Authorization', SECRET)];
    const err = await executor.execute(m).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionRefusedError);
    expect(err).toMatchObject({ code: 'SECRET_UNAVAILABLE' });
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it('refuses a stored header that is no longer valid on the wire', async () => {
    const { executor } = await setup();
    const m = monitor();
    m.headers = [sealedHeader(m.id, 'X-Injected', 'ok\r\nHost: evil.example')];
    const err = await executor.execute(m).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_HEADER' });
    expect(String((err as Error).message)).not.toContain('evil.example');
  });
});

describe('headers', () => {
  it('decrypts and sends configured headers, plus a default User-Agent', async () => {
    const { executor, reply, captured } = await setup();
    reply('/health', 'GET', 200);
    const m = monitor();
    m.headers = [
      sealedHeader(m.id, 'Authorization', SECRET),
      sealedHeader(m.id, 'X-Tenant', 'acme'),
    ];
    await executor.execute(m);
    expect(captured[0]?.headers).toMatchObject({
      authorization: SECRET,
      'x-tenant': 'acme',
      'user-agent': expect.stringMatching(/^RAIN-API-Observatory/),
    });
  });

  it('lets a configured User-Agent replace the default', async () => {
    const { executor, reply, captured } = await setup();
    reply('/health', 'GET', 200);
    const m = monitor();
    m.headers = [sealedHeader(m.id, 'User-Agent', 'acme-probe/2')];
    await executor.execute(m);
    expect(captured[0]?.headers['user-agent']).toBe('acme-probe/2');
  });
});

describe('status codes and redirects', () => {
  it.each([
    [503, 'a server error'],
    [404, 'a client error'],
    [204, 'a different 2xx'],
  ])('classifies %s (%s) as an unexpected status, keeping latency', async (statusCode) => {
    const { executor, reply } = await setup();
    reply('/health', 'GET', statusCode);
    const execution = await executor.execute(monitor());
    expect(execution.result).toEqual({
      outcome: 'FAILURE',
      statusCode,
      latencyMs: 120,
      failureReason: 'UNEXPECTED_STATUS',
    });
    expect(execution.errorMessage).toBe(
      `GET http://api.example.com/health: expected status 200, received ${statusCode}`,
    );
  });

  it('accepts the monitor’s own expected status', async () => {
    const { executor, reply } = await setup();
    reply('/health', 'GET', 204);
    const execution = await executor.execute(monitor({ expectedStatusCode: 204 }));
    expect(execution.result.outcome).toBe('SUCCESS');
  });

  it('does not follow redirects', async () => {
    const { executor, reply, agent, captured } = await setup();
    reply('/health', 'GET', 302, '', { location: `${ORIGIN}/elsewhere` });
    reply('/elsewhere', 'GET', 200);
    const execution = await executor.execute(monitor());

    expect(captured.map((c) => c.path)).toEqual(['/health']);
    expect(agent.pendingInterceptors()).toHaveLength(1);
    expect(execution.result).toMatchObject({ outcome: 'FAILURE', statusCode: 302 });
  });

  it('treats a redirect as success when that status is what the monitor expects', async () => {
    const { executor, reply } = await setup();
    reply('/health', 'GET', 301, '', { location: `${ORIGIN}/new` });
    const execution = await executor.execute(monitor({ expectedStatusCode: 301 }));
    expect(execution.result.outcome).toBe('SUCCESS');
  });
});

describe('latency', () => {
  it('measures time to response headers with the monotonic clock', async () => {
    const { executor, reply, monotonicNow } = await setup({ latency: [10_000.25, 10_234.7] });
    reply('/health', 'GET', 200);
    const execution = await executor.execute(monitor());
    expect(execution.result.latencyMs).toBe(234);
    expect(monotonicNow).toHaveBeenCalledTimes(2);
  });

  it('reports DEGRADED when slower than the latency threshold', async () => {
    const { executor, reply } = await setup({ latency: [0, 750] });
    reply('/health', 'GET', 200);
    const execution = await executor.execute(monitor({ latencyThresholdMs: 500 }));
    expect(execution.result).toMatchObject({ outcome: 'DEGRADED', latencyMs: 750 });
    expect(execution.errorMessage).toBeNull();
  });

  it('uses the real monotonic clock by default', async () => {
    const target = await startLocalTarget();
    targets.push(target);
    target.reply('/health', 'GET', 200, '', {}, { delayMs: 50 });
    const executor = createMonitorExecutor({
      transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
      secretBox: box,
    });
    const execution = await executor.execute(monitor());
    expect(execution.result.latencyMs).toBeGreaterThanOrEqual(40);
    expect(execution.result.latencyMs).toBeLessThan(2000);
  });
});

describe('no response', () => {
  it('times out at the configured timeout with NULL latency and status', async () => {
    const target = await startLocalTarget();
    targets.push(target);
    target.reply('/slow?region=eu', 'GET', 200, '', {}, { delayMs: 3000 });
    const executor = createMonitorExecutor({
      transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
      secretBox: box,
    });
    const started = Date.now();
    const execution = await executor.execute(
      monitor({ url: `${ORIGIN}/slow?region=eu`, timeoutMs: 1000 }),
    );
    const elapsed = Date.now() - started;

    expect(execution.result).toEqual({
      outcome: 'FAILURE',
      statusCode: null,
      latencyMs: null,
      failureReason: 'TIMEOUT',
    });
    expect(execution.response).toBeNull();
    expect(execution.errorMessage).toBe(
      'GET http://api.example.com/slow: no response within 1000 ms',
    );
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2500);
  });

  it.each([
    ['ENOTFOUND', 'DNS_ERROR'],
    ['EAI_AGAIN', 'DNS_ERROR'],
    ['ECONNREFUSED', 'CONNECTION_ERROR'],
    ['ECONNRESET', 'CONNECTION_ERROR'],
    ['UND_ERR_SOCKET', 'CONNECTION_ERROR'],
    ['CERT_HAS_EXPIRED', 'TLS_ERROR'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_ERROR'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_ERROR'],
    ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT'],
    ['SOMETHING_ELSE', 'REQUEST_ERROR'],
  ])('maps %s to %s with NULL latency and status', async (code, reason) => {
    const { executor, target } = await setup();
    const err = Object.assign(new Error(`boom ${SECRET} at ${ORIGIN}/health?token=abc`), { code });
    target.failNextConnection(err);
    const m = monitor();
    m.headers = [sealedHeader(m.id, 'Authorization', SECRET)];

    const execution = await executor.execute(m);

    expect(execution.result).toEqual({
      outcome: 'FAILURE',
      statusCode: null,
      latencyMs: null,
      failureReason: reason,
    });
    // The raw error text (which here contains a secret and a query string) is never used.
    expect(execution.errorMessage).toMatch(/^GET http:\/\/api\.example\.com\/health: /);
    expect(JSON.stringify(execution)).not.toContain(SECRET);
    expect(JSON.stringify(execution)).not.toContain('token=abc');
    expect(JSON.stringify(execution)).not.toContain('boom');
    // Exactly one connection attempt: undici must not silently reconnect and send it anyway.
    expect(target.pinned).toHaveLength(1);
    expect(target.captured).toHaveLength(0);
  });

  it('finds error codes wrapped in a cause chain', () => {
    const wrapped = new Error('fetch failed', {
      cause: Object.assign(new Error('inner'), { code: 'ECONNREFUSED' }),
    });
    expect(noResponseReason(wrapped, false)).toBe('CONNECTION_ERROR');
    expect(noResponseReason(new Error('anything'), true)).toBe('TIMEOUT');
  });
});

describe('response bodies', () => {
  const KB = 1024;

  /**
   * A finite body of `totalChunks` chunks. With `highWaterMark: 0` the stream produces a chunk
   * only when the consumer asks for one, so `produced` is exactly the number of chunks requested.
   */
  function boundedBody(totalChunks: number, chunkBytes: number, highWaterMark = 0) {
    const state = { produced: 0 };
    const stream = new Readable({
      highWaterMark,
      read() {
        if (state.produced === totalChunks) {
          this.push(null);
          return;
        }
        state.produced += 1;
        this.push(Buffer.alloc(chunkBytes, 'a'));
      },
    });
    return { stream, state };
  }

  it('consumes exactly 64 KB, requests no further chunk, and cancels the stream', async () => {
    // 1 MB in 16 KB chunks: the limit is reached exactly at the end of chunk 4.
    const { stream, state } = boundedBody(64, 16 * KB);

    const info = await drainResponseBody(stream, 64 * KB);

    expect(info).toEqual({ bodyBytesRead: 64 * KB, bodyLimitReached: true });
    expect(info.bodyBytesRead).toBeLessThanOrEqual(64 * KB);
    // Four chunks were requested; the fifth was never asked for, not even to look for more data.
    expect(state.produced).toBe(4);
    expect(stream.destroyed).toBe(true);
  });

  it('never counts past the limit when a chunk crosses it', async () => {
    // 20 KB chunks: 60 KB after three, the fourth crosses 64 KB.
    const { stream, state } = boundedBody(50, 20 * KB);

    const info = await drainResponseBody(stream, 64 * KB);

    expect(info).toEqual({ bodyBytesRead: 64 * KB, bodyLimitReached: true });
    expect(state.produced).toBe(4);
    expect(stream.destroyed).toBe(true);
  });

  it('keeps stream read-ahead to a single unconsumed chunk with default buffering', async () => {
    // Node's default high-water mark may prefetch one chunk; it is produced but never consumed.
    const { stream, state } = boundedBody(64, 16 * KB, 16 * KB);
    const info = await drainResponseBody(stream, 64 * KB);
    expect(info.bodyBytesRead).toBe(64 * KB);
    expect(state.produced).toBeLessThanOrEqual(5);
    expect(stream.destroyed).toBe(true);
  });

  it('reads a body shorter than the limit to its end', async () => {
    const { stream, state } = boundedBody(3, 16 * KB);
    const info = await drainResponseBody(stream, 64 * KB);
    expect(info).toEqual({ bodyBytesRead: 48 * KB, bodyLimitReached: false });
    expect(state.produced).toBe(3);
  });

  it('stops at a body of exactly the limit without reading on to find its end', async () => {
    // Whether more data exists is deliberately not checked, so this reports the limit as reached.
    const { stream, state } = boundedBody(4, 16 * KB);
    const info = await drainResponseBody(stream, 64 * KB);
    expect(info).toEqual({ bodyBytesRead: 64 * KB, bodyLimitReached: true });
    expect(state.produced).toBe(4);
  });

  it('applies the executor’s default response limit of 64 KB', async () => {
    const { stream, state } = boundedBody(64, 16 * KB);
    const info = await drainResponseBody(stream);
    expect(EXECUTOR_LIMITS.responseBodyMaxBytes).toBe(64 * KB);
    expect(info).toEqual({ bodyBytesRead: 64 * KB, bodyLimitReached: true });
    expect(state.produced).toBe(4);
  });

  it('closes the body when it fails part-way, keeping what was counted', async () => {
    const failing = new Readable({ read() {} });
    failing.push(Buffer.alloc(10));
    queueMicrotask(() => failing.destroy(new Error('socket hang up')));
    const info = await drainResponseBody(failing);
    expect(info).toEqual({ bodyBytesRead: 10, bodyLimitReached: false });
    expect(failing.destroyed).toBe(true);
  });

  it('reads a small body to the end and reports its size', async () => {
    const { executor, reply } = await setup();
    reply('/health', 'GET', 200, '{"ok":true}');
    const execution = await executor.execute(monitor());
    expect(execution.response).toEqual({ bodyBytesRead: 11, bodyLimitReached: false });
  });

  it('caps what the executor consumes from a large response at 64 KB', async () => {
    const { executor, reply } = await setup();
    reply('/health', 'GET', 200, Buffer.alloc(4 * 1024 * 1024, 'a'));
    const execution = await executor.execute(monitor());
    expect(execution.result.outcome).toBe('SUCCESS');
    expect(execution.response).toEqual({ bodyBytesRead: 64 * KB, bodyLimitReached: true });
  });

  it('never includes response content in the result', async () => {
    const { executor, reply } = await setup();
    reply('/health', 'GET', 500, 'internal secret stack trace');
    const execution = await executor.execute(monitor());
    expect(JSON.stringify(execution)).not.toContain('stack trace');
  });
});

describe('sanitisation and isolation', () => {
  it('keeps headers, bodies and query strings out of every result and message', async () => {
    const { executor, reply } = await setup();
    reply('/v1/status?tenant=acme-private-id', 'POST', 500);
    const m = monitor({
      url: `${ORIGIN}/v1/status?tenant=acme-private-id`,
      method: 'POST',
      body: BODY,
      allowMutatingRequests: true,
    });
    m.headers = [sealedHeader(m.id, 'Authorization', SECRET)];

    const execution = await executor.execute(m);
    const serialised = JSON.stringify(execution);

    expect(execution.errorMessage).toBe(
      'POST http://api.example.com/v1/status: expected status 200, received 500',
    );
    for (const secret of [SECRET, 'body-secret-77', 'acme-private-id']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('records the wall-clock start time separately from latency', async () => {
    const { executor, reply, checkedAt } = await setup();
    reply('/health', 'GET', 200);
    expect((await executor.execute(monitor())).checkedAt).toBe(checkedAt);
  });

  it('refuses any dispatcher that is not the SSRF-safe one, in every environment', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const executor = createMonitorExecutor({
      transport: { kind: 'dispatcher', dispatcher: agent },
      secretBox: box,
    });
    await expect(executor.execute(monitor())).rejects.toMatchObject({
      code: 'OUTBOUND_DISABLED',
    });
    await agent.close();
  });

  it('exposes no way to send without a transport', () => {
    // The transport is a required dependency; the only built-in one refuses everything.
    const transports: MonitorTransport[] = [OUTBOUND_DISABLED];
    expect(transports.map((t) => t.kind)).toEqual(['disabled']);
  });
});
