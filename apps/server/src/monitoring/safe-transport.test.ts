import { randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { isIP, type AddressInfo, type Socket } from 'node:net';
import tls from 'node:tls';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from '../test-support/tls-fixture.js';
import {
  OUTBOUND_DISABLED,
  createMonitorExecutor,
  createProductionTransport,
  createSafeTransport,
  type ExecutableMonitor,
} from './executor.js';
import {
  BlockedDestinationError,
  DestinationResolutionError,
  createSafeConnector,
  defaultSocketFactory,
  resolvePinnedAddress,
  tlsOptionsFor,
  type PinnedTarget,
  type ResolvedAddress,
  type Resolver,
  type SocketFactory,
} from './safe-transport.js';

// No test here reaches real or private infrastructure. DNS is an injected function, and the
// socket factory records the validated target and then connects to a local test server instead.

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';
const box = createSecretBox({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

/** A resolver that answers from a script, one answer list per call, recording each call. */
function scriptedResolver(...answers: Array<ResolvedAddress[] | Error>) {
  const calls: string[] = [];
  const resolver: Resolver = async (hostname) => {
    calls.push(hostname);
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { resolver, calls };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

/** Records every pinned target, then connects to a local server instead of the real address. */
function divertingFactory(local: { port: number; tls?: tls.ConnectionOptions }) {
  const targets: PinnedTarget[] = [];
  const factory: SocketFactory = (target) => {
    targets.push(target);
    if (target.protocol === 'https:') {
      // The real TLS options for the target, only re-pointed at the local server.
      return tls.connect({
        ...tlsOptionsFor(target),
        ...local.tls,
        host: '127.0.0.1',
        port: local.port,
      });
    }
    return net.connect({ host: '127.0.0.1', port: local.port });
  };
  return { factory, targets };
}

/** Calls the connector directly and resolves with its outcome. */
function connectWith(
  connector: ReturnType<typeof createSafeConnector>,
  request: { hostname: string; protocol?: string; port?: string; socketPath?: string },
) {
  return new Promise<{ err: Error | null; socket: Socket | null }>((resolve) => {
    connector(
      {
        hostname: request.hostname,
        protocol: request.protocol ?? 'https:',
        port: request.port ?? '',
        ...(request.socketPath && { socketPath: request.socketPath }),
      },
      (err, socket) => {
        socket?.destroy();
        resolve({ err, socket });
      },
    );
  });
}

async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const requests: Array<{ host: string | undefined; path: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ host: req.headers.host, path: req.url });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  cleanups.push(() => server.closeAllConnections());
  return { port: (server.address() as AddressInfo).port, requests };
}

async function startHttpsServer() {
  const sni: Array<string | undefined> = [];
  const requests: Array<string | undefined> = [];
  const server = https.createServer(
    {
      cert: TEST_TLS_CERT,
      key: TEST_TLS_KEY,
      SNICallback: (servername, cb) => {
        sni.push(servername);
        cb(null, tls.createSecureContext({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }));
      },
    },
    (req, res) => {
      requests.push(req.headers.host);
      // No 'Connection: close': closing the TLS socket right after the response races into a
      // reset on Windows loopback (seen as a rare CONNECTION_ERROR). Cleanup closes connections.
      res.writeHead(200).end('ok');
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  cleanups.push(() => server.closeAllConnections());
  return { port: (server.address() as AddressInfo).port, sni, requests };
}

function monitor(url: string, overrides: Partial<ExecutableMonitor> = {}): ExecutableMonitor {
  return {
    id: randomUUID(),
    url,
    method: 'GET',
    expectedStatusCode: 200,
    timeoutMs: 5000,
    latencyThresholdMs: 2000,
    requestBody: null,
    bodyContentType: null,
    headers: [],
    allowMutatingRequests: false,
    ...overrides,
  };
}

function executorWith(options: Parameters<typeof createSafeTransport>[0]) {
  const transport = createSafeTransport(options);
  if (transport.kind === 'dispatcher') {
    cleanups.push(() => transport.dispatcher.close());
  }
  return createMonitorExecutor({ transport, secretBox: box });
}

describe('connector: schemes and ports', () => {
  it.each([
    [
      'an unsupported scheme',
      { hostname: 'api.example.com', protocol: 'ftp:' },
      'UNSUPPORTED_SCHEME',
    ],
    ['a custom HTTPS port', { hostname: 'api.example.com', port: '8443' }, 'UNSUPPORTED_PORT'],
    [
      'a custom HTTP port',
      { hostname: 'api.example.com', protocol: 'http:', port: '8080' },
      'UNSUPPORTED_PORT',
    ],
    ['HTTPS on port 80', { hostname: 'api.example.com', port: '80' }, 'UNSUPPORTED_PORT'],
    [
      'HTTP on port 443',
      { hostname: 'api.example.com', protocol: 'http:', port: '443' },
      'UNSUPPORTED_PORT',
    ],
    [
      'a Unix socket',
      { hostname: 'api.example.com', socketPath: '/var/run/docker.sock' },
      'UNSUPPORTED_SOCKET',
    ],
  ])('refuses %s without resolving or connecting', async (_label, request, reason) => {
    const { resolver, calls } = scriptedResolver([v4(PUBLIC_V4)]);
    const factory = vi.fn<SocketFactory>();
    const { err } = await connectWith(
      createSafeConnector({ resolver, socketFactory: factory }),
      request,
    );
    expect(err).toBeInstanceOf(BlockedDestinationError);
    expect(err).toMatchObject({ reason, code: 'ERR_RAIN_BLOCKED_DESTINATION' });
    expect(calls).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    ['https:', '', 443],
    ['https:', '443', 443],
    ['http:', '', 80],
    ['http:', '80', 80],
  ])('allows %s with port %j (effective port %i)', async (protocol, port, effective) => {
    const { resolver } = scriptedResolver([v4(PUBLIC_V4)]);
    const targets: PinnedTarget[] = [];
    // Records the validated target and stops there; no connection is needed to check the port.
    const factory: SocketFactory = (t) => {
      targets.push(t);
      const s = new net.Socket();
      queueMicrotask(() => s.destroy(new Error('stop here')));
      return s;
    };
    const { err } = await connectWith(createSafeConnector({ resolver, socketFactory: factory }), {
      hostname: 'api.example.com',
      protocol,
      port,
    });
    // Not refused by the guard: it got as far as opening a socket to the validated address.
    expect(err).not.toBeInstanceOf(BlockedDestinationError);
    expect(targets).toEqual([
      expect.objectContaining({ protocol, port: effective, address: PUBLIC_V4 }),
    ]);
  });
});

describe('connector: IP-literal URLs', () => {
  it.each([
    ['10.0.0.1', 'PRIVATE'],
    ['127.0.0.1', 'LOOPBACK'],
    ['169.254.169.254', 'LINK_LOCAL'],
    ['[::1]', 'LOOPBACK'],
    ['[fd00::1]', 'UNIQUE_LOCAL'],
    ['[::ffff:10.0.0.1]', 'PRIVATE'],
  ])('refuses the literal %s (%s) without any DNS lookup', async (hostname, reason) => {
    const { resolver, calls } = scriptedResolver([v4(PUBLIC_V4)]);
    const factory = vi.fn<SocketFactory>();
    const { err } = await connectWith(createSafeConnector({ resolver, socketFactory: factory }), {
      hostname,
    });
    expect(err).toMatchObject({ reason });
    expect(calls).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([PUBLIC_V4, `[${PUBLIC_V6}]`])(
    'connects to the public literal %s itself, with no SNI',
    async (hostname) => {
      const { resolver, calls } = scriptedResolver([v4('10.0.0.1')]);
      const targets: PinnedTarget[] = [];
      const factory: SocketFactory = (t) => {
        targets.push(t);
        const s = new net.Socket();
        queueMicrotask(() => s.destroy(new Error('stop here')));
        return s;
      };
      await connectWith(createSafeConnector({ resolver, socketFactory: factory }), { hostname });
      expect(calls).toHaveLength(0);
      expect(targets).toEqual([
        expect.objectContaining({
          address: hostname.replace(/^\[|\]$/g, ''),
          servername: undefined,
        }),
      ]);
    },
  );
});

describe('DNS validation', () => {
  it('rejects the whole hostname when any answer is private', async () => {
    for (const answers of [
      [v4(PUBLIC_V4), v4('10.0.0.5')],
      [v4('192.168.1.10'), v4(PUBLIC_V4)],
      [v4(PUBLIC_V4), v6('fd00::1')],
      [v6(PUBLIC_V6), v6('::ffff:127.0.0.1')],
    ]) {
      await expect(
        resolvePinnedAddress('api.example.com', scriptedResolver(answers).resolver, 1000),
      ).rejects.toBeInstanceOf(BlockedDestinationError);
    }
  });

  it('rejects answers that are not IP addresses at all', async () => {
    await expect(
      resolvePinnedAddress('api.example.com', scriptedResolver([v4('not-an-ip')]).resolver, 1000),
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('treats an empty answer as a resolution failure', async () => {
    await expect(
      resolvePinnedAddress('api.example.com', scriptedResolver([]).resolver, 1000),
    ).rejects.toMatchObject({ name: 'DestinationResolutionError', code: 'ENODATA' });
  });

  it('keeps the DNS error code of a failed lookup', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    await expect(
      resolvePinnedAddress('nope.example.com', scriptedResolver(failure).resolver, 1000),
    ).rejects.toEqual(new DestinationResolutionError('ENOTFOUND'));
  });

  it('gives up on a resolver that never answers', async () => {
    const hanging: Resolver = () => new Promise(() => {});
    await expect(resolvePinnedAddress('slow.example.com', hanging, 50)).rejects.toMatchObject({
      code: 'ETIMEOUT',
    });
  });

  it('pins the first validated address, preserving the hostname and SNI', async () => {
    const { resolver } = scriptedResolver([v4(PUBLIC_V4), v6(PUBLIC_V6)]);
    const targets: PinnedTarget[] = [];
    const factory: SocketFactory = (t) => {
      targets.push(t);
      const s = new net.Socket();
      queueMicrotask(() => s.destroy(new Error('stop here')));
      return s;
    };
    await connectWith(createSafeConnector({ resolver, socketFactory: factory }), {
      hostname: 'api.example.com',
    });
    expect(targets).toEqual([
      {
        protocol: 'https:',
        hostname: 'api.example.com',
        address: PUBLIC_V4,
        family: 4,
        port: 443,
        servername: 'api.example.com',
      },
    ]);
  });

  it('resolves localhost through the real system resolver and refuses it', async () => {
    // Only the local hosts file is involved; no network request is made.
    const { err } = await connectWith(createSafeConnector(), { hostname: 'localhost' });
    expect(err).toBeInstanceOf(BlockedDestinationError);
    expect(['LOOPBACK']).toContain((err as BlockedDestinationError).reason);
  });
});

describe('TLS options', () => {
  const target: PinnedTarget = {
    protocol: 'https:',
    hostname: 'api.example.com',
    address: PUBLIC_V4,
    family: 4,
    port: 443,
    servername: 'api.example.com',
  };

  it('connects to the pinned IP, verifies the certificate, and sends the hostname as SNI', () => {
    const options = tlsOptionsFor(target);
    expect(options).toMatchObject({
      host: PUBLIC_V4,
      port: 443,
      servername: 'api.example.com',
      rejectUnauthorized: true,
    });
    expect(isIP(String(options.host))).toBe(4);
    // Nothing replaces Node's own hostname check or lookup.
    expect(options).not.toHaveProperty('checkServerIdentity');
    expect(options).not.toHaveProperty('lookup');
  });

  it('opens plain HTTP sockets to the IP address too', () => {
    const spy = vi.spyOn(net, 'connect').mockReturnValue(new net.Socket());
    defaultSocketFactory({ ...target, protocol: 'http:', port: 80, servername: undefined });
    expect(spy).toHaveBeenCalledWith({ host: PUBLIC_V4, port: 80, family: 4 });
  });
});

describe('end to end through the executor', () => {
  it('sends the original Host header to the pinned address and succeeds', async () => {
    const local = await startHttpServer((_req, res) => res.writeHead(200).end('ok'));
    const { resolver, calls } = scriptedResolver([v4(PUBLIC_V4)]);
    const { factory, targets } = divertingFactory({ port: local.port });
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('http://api.example.com/health'),
    );
    expect(execution.result).toMatchObject({ outcome: 'SUCCESS', statusCode: 200 });
    expect(calls).toEqual(['api.example.com']);
    expect(targets.map((t) => t.address)).toEqual([PUBLIC_V4]);
    expect(local.requests).toEqual([{ host: 'api.example.com', path: '/health' }]);
  });

  it('records a private DNS answer as BLOCKED_DESTINATION without connecting', async () => {
    const { resolver } = scriptedResolver([v4(PUBLIC_V4), v4('10.20.30.40')]);
    const factory = vi.fn<SocketFactory>();
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('https://api.example.com/health'),
    );
    expect(execution.result).toEqual({
      outcome: 'FAILURE',
      statusCode: null,
      latencyMs: null,
      failureReason: 'BLOCKED_DESTINATION',
    });
    expect(execution.errorMessage).toBe(
      'GET https://api.example.com/health: the destination is not allowed',
    );
    expect(execution.errorMessage).not.toContain('10.20.30.40');
    expect(factory).not.toHaveBeenCalled();
  });

  it('records DNS failures and empty answers as DNS_ERROR', async () => {
    const notFound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    for (const resolver of [scriptedResolver(notFound).resolver, scriptedResolver([]).resolver]) {
      const execution = await executorWith({ resolver }).execute(
        monitor('https://api.example.com/health'),
      );
      expect(execution.result).toMatchObject({ failureReason: 'DNS_ERROR', latencyMs: null });
    }
  });

  it('revalidates every new connection and stops a DNS rebinding attempt', async () => {
    // The server drops each connection once the response is out, so the second check needs a new
    // one. (Closing a little later avoids a close-vs-read race on some platforms.)
    const local = await startHttpServer((req, res) => {
      res.writeHead(200, { 'content-length': '2' }).end('ok', () => {
        setTimeout(() => req.socket.destroy(), 50);
      });
    });
    const { resolver, calls } = scriptedResolver([v4(PUBLIC_V4)], [v4('127.0.0.1')]);
    const { factory, targets } = divertingFactory({ port: local.port });
    const sockets: Socket[] = [];
    const tracking: SocketFactory = (t) => {
      const socket = factory(t);
      sockets.push(socket);
      return socket;
    };
    const executor = executorWith({ resolver, socketFactory: tracking });

    const first = await executor.execute(monitor('http://api.example.com/health'));
    // Let the server's close reach the client, so the second check really needs a new connection.
    await vi.waitFor(() => expect(sockets.every((s) => s.destroyed)).toBe(true));
    const second = await executor.execute(monitor('http://api.example.com/health'));

    expect(first.result.outcome).toBe('SUCCESS');
    expect(second.result).toMatchObject({
      outcome: 'FAILURE',
      failureReason: 'BLOCKED_DESTINATION',
    });
    expect(calls).toEqual(['api.example.com', 'api.example.com']);
    // The rebound (private) answer never produced a socket.
    expect(targets.map((t) => t.address)).toEqual([PUBLIC_V4]);
    expect(local.requests).toHaveLength(1);
  });

  it('does not follow redirects, even to a public address', async () => {
    const local = await startHttpServer((_req, res) =>
      res.writeHead(302, { location: 'http://other.example.com/next' }).end(),
    );
    const { resolver, calls } = scriptedResolver([v4(PUBLIC_V4)]);
    const { factory } = divertingFactory({ port: local.port });
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('http://api.example.com/health'),
    );
    expect(execution.result).toMatchObject({ outcome: 'FAILURE', statusCode: 302 });
    expect(local.requests).toHaveLength(1);
    expect(calls).toEqual(['api.example.com']);
  });

  it('never calls the system DNS resolver when connecting', async () => {
    // Start the local server first: its own listen() does a lookup that isn't part of the check.
    const local = await startHttpServer((_req, res) => res.writeHead(200).end());
    const lookup = vi.spyOn(dns, 'lookup');
    const promisesLookup = vi.spyOn(dns.promises, 'lookup');
    const { resolver } = scriptedResolver([v4(PUBLIC_V4)]);
    const { factory } = divertingFactory({ port: local.port });
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('http://api.example.com/health'),
    );
    expect(execution.result.outcome).toBe('SUCCESS');
    // Any call is reported with the host it was for, to tell a real leak from test noise.
    expect(lookup.mock.calls.map((c) => c[0])).toEqual([]);
    expect(promisesLookup.mock.calls.map((c) => c[0])).toEqual([]);
  });

  it('ignores proxy environment variables', async () => {
    const saved = { ...process.env };
    cleanups.push(() => {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
    // A proxy on a closed local port: if it were used, the check would fail to connect.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']) {
      process.env[key] = 'http://127.0.0.1:9';
    }
    const local = await startHttpServer((_req, res) => res.writeHead(200).end());
    const { resolver, calls } = scriptedResolver([v4(PUBLIC_V4)]);
    const { factory, targets } = divertingFactory({ port: local.port });
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('http://api.example.com/health'),
    );
    expect(execution.result.outcome).toBe('SUCCESS');
    expect(calls).toEqual(['api.example.com']);
    expect(targets[0]?.address).toBe(PUBLIC_V4);
  });
});

describe('TLS end to end (local server, throwaway test certificate)', () => {
  it('keeps certificate verification on: an untrusted certificate fails the check', async () => {
    const server = await startHttpsServer();
    const { resolver } = scriptedResolver([v4(PUBLIC_V4)]);
    const { factory } = divertingFactory({ port: server.port });
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('https://api.example.com/health'),
    );
    expect(execution.result).toMatchObject({ outcome: 'FAILURE', failureReason: 'TLS_ERROR' });
    // SNI carried the original hostname even though the socket went to an IP address.
    expect(server.sni).toEqual(['api.example.com']);
    expect(server.requests).toHaveLength(0);
  });

  it('verifies against the original hostname: trusted and matching succeeds', async () => {
    const server = await startHttpsServer();
    const { resolver } = scriptedResolver([v4(PUBLIC_V4)]);
    // Trust the test certificate (test-only CA override); everything else is the real path.
    const { factory } = divertingFactory({ port: server.port, tls: { ca: TEST_TLS_CERT } });
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('https://api.example.com/health'),
    );
    expect(execution.result).toMatchObject({ outcome: 'SUCCESS', statusCode: 200 });
    expect(server.sni).toEqual(['api.example.com']);
    expect(server.requests).toEqual(['api.example.com']);
  });

  it('verifies against the original hostname: a certificate for another name fails', async () => {
    const server = await startHttpsServer();
    const { resolver } = scriptedResolver([v4(PUBLIC_V4)]);
    const { factory } = divertingFactory({ port: server.port, tls: { ca: TEST_TLS_CERT } });
    const execution = await executorWith({ resolver, socketFactory: factory }).execute(
      monitor('https://other.example.com/health'),
    );
    expect(execution.result).toMatchObject({ outcome: 'FAILURE', failureReason: 'TLS_ERROR' });
    expect(server.sni).toEqual(['other.example.com']);
    expect(server.requests).toHaveLength(0);
  });
});

describe('production wiring', () => {
  it('builds the safe transport for production', () => {
    const transport = createProductionTransport();
    expect(transport.kind).toBe('dispatcher');
    if (transport.kind === 'dispatcher') cleanups.push(() => transport.dispatcher.close());
  });

  it('falls back to refusing everything if the safe transport cannot be built', () => {
    expect(
      createProductionTransport(() => {
        throw new Error('boom');
      }),
    ).toBe(OUTBOUND_DISABLED);
  });

  it('never accepts an unvalidated dispatcher as the production transport', () => {
    const agent = new MockAgent();
    cleanups.push(() => agent.close());
    expect(createProductionTransport(() => ({ kind: 'dispatcher', dispatcher: agent }))).toBe(
      OUTBOUND_DISABLED,
    );
  });

  it('refuses to send through any other dispatcher in production', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    cleanups.push(() => agent.close());
    const executor = createMonitorExecutor({
      transport: { kind: 'dispatcher', dispatcher: agent },
      secretBox: box,
    });
    await expect(executor.execute(monitor('https://api.example.com/'))).rejects.toMatchObject({
      code: 'OUTBOUND_DISABLED',
    });
  });
});
