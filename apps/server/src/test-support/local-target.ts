/**
 * TEST ONLY. A controlled "remote API" for executor and worker tests, reached through the REAL
 * SSRF-safe dispatcher: DNS answers come from an injected resolver (a public documentation-free
 * address), and the socket that the safe connector opens to that validated address is diverted to
 * a local HTTP server. Every SSRF rule still runs; only the network endpoint is local.
 */
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Dispatcher } from 'undici';
import {
  createSafeDispatcher,
  type PinnedTarget,
  type ResolvedAddress,
  type Resolver,
} from '../monitoring/safe-transport.js';

/** What the resolver answers for every hostname unless a test overrides it. */
export const LOCAL_TARGET_PUBLIC_IP = '93.184.216.34';

export interface CapturedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface Route {
  method: string;
  path: string;
  statusCode: number;
  data: string | Buffer;
  headers: Record<string, string>;
  delayMs: number;
  used: boolean;
}

export interface LocalTarget {
  dispatcher: Dispatcher;
  port: number;
  /** Requests the server received, in order. */
  captured: CapturedRequest[];
  /** Hostnames the injected resolver was asked about, in order. */
  resolverCalls: string[];
  /** Addresses the safe connector validated and pinned, in order. */
  pinned: PinnedTarget[];
  /** Registers a one-shot response for method + path (path includes any query string). */
  reply(
    path: string,
    method: string,
    statusCode?: number,
    data?: string | Buffer,
    headers?: Record<string, string>,
    options?: { delayMs?: number },
  ): void;
  /** Registered responses not yet used. */
  pendingRoutes(): number;
  /** Makes the next connection attempt fail with this error (e.g. `{ code: 'ECONNREFUSED' }`). */
  failNextConnection(error: Error): void;
  /** Replaces the DNS answers for subsequent lookups. */
  setDnsAnswers(answers: ResolvedAddress[] | Error): void;
  close(): Promise<void>;
}

export async function startLocalTarget(): Promise<LocalTarget> {
  const routes: Route[] = [];
  const captured: CapturedRequest[] = [];
  const resolverCalls: string[] = [];
  const pinned: PinnedTarget[] = [];
  const connectionFailures: Error[] = [];
  let dnsAnswers: ResolvedAddress[] | Error = [{ address: LOCAL_TARGET_PUBLIC_IP, family: 4 }];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      captured.push({
        path: req.url ?? '',
        method: req.method ?? '',
        headers,
        body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      });
      const route = routes.find((r) => !r.used && r.method === req.method && r.path === req.url);
      if (!route) {
        res.writeHead(599, { 'content-type': 'text/plain' }).end('no route registered');
        return;
      }
      route.used = true;
      const send = () => {
        res.on('error', () => {});
        res.writeHead(route.statusCode, route.headers).end(route.data);
      };
      if (route.delayMs > 0) setTimeout(send, route.delayMs);
      else send();
    });
  });
  // Clients that stop reading large bodies close the socket; that's expected here.
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const resolver: Resolver = async (hostname) => {
    resolverCalls.push(hostname);
    if (dnsAnswers instanceof Error) throw dnsAnswers;
    return dnsAnswers;
  };

  const dispatcher = createSafeDispatcher({
    resolver,
    socketFactory: (target) => {
      pinned.push(target);
      const failure = connectionFailures.shift();
      if (failure) {
        const socket = new net.Socket();
        queueMicrotask(() => socket.destroy(failure));
        return socket;
      }
      // The validated address stands for a remote host; the bytes go to the local server.
      return net.connect({ host: '127.0.0.1', port });
    },
  });

  return {
    dispatcher,
    port,
    captured,
    resolverCalls,
    pinned,
    reply(path, method, statusCode = 200, data = '', headers = {}, options = {}) {
      routes.push({
        method,
        path,
        statusCode,
        data,
        headers,
        delayMs: options.delayMs ?? 0,
        used: false,
      });
    },
    pendingRoutes: () => routes.filter((r) => !r.used).length,
    failNextConnection(error) {
      connectionFailures.push(error);
    },
    setDnsAnswers(answers) {
      dnsAnswers = answers;
    },
    async close() {
      await dispatcher.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
