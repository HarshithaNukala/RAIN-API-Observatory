import { promises as dnsPromises } from 'node:dns';
import net, { isIP, type Socket } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import {
  DEFAULT_MONITOR_PORT_POLICY,
  classifyIpAddress,
  type IpBlockReason,
  type MonitorProtocol,
} from '@rain/shared';
import { Agent, type Dispatcher, type buildConnector } from 'undici';

/**
 * SSRF-safe outbound transport for monitor checks (docs/security/monitor-network-security.md).
 *
 * Every new connection goes through `createSafeConnector`, which:
 *  1. accepts only http: on port 80 and https: on port 443;
 *  2. validates an IP-literal host directly, or resolves a hostname's A and AAAA records (CNAMEs
 *     followed to their final addresses) and rejects the hostname if ANY answer is non-public;
 *  3. opens the socket to the exact validated IP, so Node performs no DNS lookup of its own;
 *  4. keeps the original hostname for TLS SNI and certificate verification (never disabled) while
 *     undici keeps it in the HTTP Host header.
 * The check runs again for every new connection, so a DNS answer that changes between connections
 * (rebinding) is caught. Redirects are never followed and environment proxies are never consulted:
 * the Agent is constructed directly, without proxy or redirect interceptors.
 */

export type BlockReason =
  IpBlockReason | 'UNSUPPORTED_SCHEME' | 'UNSUPPORTED_PORT' | 'UNSUPPORTED_SOCKET';

/** A destination the guard refused. The message never includes resolved addresses. */
export class BlockedDestinationError extends Error {
  readonly code = 'ERR_RAIN_BLOCKED_DESTINATION';
  constructor(readonly reason: BlockReason) {
    super(`Destination blocked (${reason})`);
    this.name = 'BlockedDestinationError';
  }
}

/** DNS gave no usable answer. `code` follows Node's DNS error codes. */
export class DestinationResolutionError extends Error {
  constructor(readonly code: string) {
    super(`The destination host name could not be resolved (${code})`);
    this.name = 'DestinationResolutionError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Returns every A and AAAA address for a hostname, with CNAMEs followed to the final records. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** The operating system resolver (getaddrinfo), asking for all addresses of both families. */
export const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsPromises.lookup(hostname, { all: true, family: 0, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Everything a socket needs to reach the validated address. `address` is always an IP. */
export interface PinnedTarget {
  protocol: MonitorProtocol;
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
  /** The original hostname for SNI and certificate checks; absent for IP-literal URLs. */
  servername: string | undefined;
}

export type SocketFactory = (target: PinnedTarget) => Socket;

/**
 * TLS options for a pinned connection. `host` is the validated IP, so Node does no lookup;
 * `servername` is the original hostname, so SNI and certificate verification use it.
 * Verification is always on: there is deliberately no way to turn it off.
 */
export function tlsOptionsFor(target: PinnedTarget): ConnectionOptions {
  return {
    host: target.address,
    port: target.port,
    servername: target.servername,
    rejectUnauthorized: true,
    ALPNProtocols: ['http/1.1'],
  };
}

export const defaultSocketFactory: SocketFactory = (target) =>
  target.protocol === 'https:'
    ? tls.connect(tlsOptionsFor(target))
    : net.connect({ host: target.address, port: target.port, family: target.family });

const DEFAULT_PORTS: Record<MonitorProtocol, number> = { 'http:': 80, 'https:': 443 };

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Turns a URL host into the one address to connect to, or throws. IP literals are classified
 * directly; hostnames are resolved and rejected if any answer is not public.
 */
export async function resolvePinnedAddress(
  host: string,
  resolver: Resolver,
  dnsTimeoutMs: number,
): Promise<ResolvedAddress> {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare)) {
    const verdict = classifyIpAddress(bare);
    if (!verdict.allowed) throw new BlockedDestinationError(verdict.reason);
    return { address: bare, family: verdict.family };
  }

  let answers: ResolvedAddress[];
  try {
    answers = await withTimeout(
      resolver(bare),
      dnsTimeoutMs,
      () => new DestinationResolutionError('ETIMEOUT'),
    );
  } catch (err) {
    if (err instanceof DestinationResolutionError) throw err;
    const code = (err as { code?: unknown }).code;
    throw new DestinationResolutionError(typeof code === 'string' ? code : 'ENOTFOUND');
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new DestinationResolutionError('ENODATA');
  }

  // One non-public answer is enough to refuse the hostname: an attacker who controls DNS could
  // otherwise mix a private address in and hope it is the one used.
  let first: ResolvedAddress | undefined;
  for (const answer of answers) {
    const verdict = classifyIpAddress(String(answer.address));
    if (!verdict.allowed) throw new BlockedDestinationError(verdict.reason);
    first ??= { address: answer.address, family: verdict.family };
  }
  return first!;
}

export interface SafeConnectorOptions {
  resolver?: Resolver;
  socketFactory?: SocketFactory;
  dnsTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/**
 * undici treats a connection failure coded UND_ERR_SOCKET or UND_ERR_INFO as recoverable and
 * silently reconnects. Each check gets exactly one connection attempt, so those codes are mapped to
 * ECONNRESET, which undici reports to the request instead. (Requests that were already sent are
 * never retried: no retry handler is installed.)
 */
function terminalConnectError(err: Error): Error {
  const code = (err as { code?: unknown }).code;
  if (code !== 'UND_ERR_SOCKET' && code !== 'UND_ERR_INFO') return err;
  return Object.assign(new Error('The connection failed'), { code: 'ECONNRESET', cause: err });
}

/** An undici connector that validates and pins every new connection. */
export function createSafeConnector(options: SafeConnectorOptions = {}): buildConnector.connector {
  const resolver = options.resolver ?? systemResolver;
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 5000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;

  return (request, callback) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      callback(terminalConnectError(err), null);
    };

    const protocol = request.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      fail(new BlockedDestinationError('UNSUPPORTED_SCHEME'));
      return;
    }
    // Unix sockets and pre-opened sockets (proxy tunnels) would skip address validation.
    if (request.socketPath || request.httpSocket) {
      fail(new BlockedDestinationError('UNSUPPORTED_SOCKET'));
      return;
    }
    const port = request.port === '' ? DEFAULT_PORTS[protocol] : Number(request.port);
    if (!DEFAULT_MONITOR_PORT_POLICY[protocol].includes(port)) {
      fail(new BlockedDestinationError('UNSUPPORTED_PORT'));
      return;
    }

    const hostname = request.hostname.replace(/^\[(.*)\]$/, '$1');
    resolvePinnedAddress(hostname, resolver, dnsTimeoutMs).then(
      (pinned) => {
        const socket = socketFactory({
          protocol,
          hostname,
          address: pinned.address,
          family: pinned.family,
          port,
          // SNI never carries an IP address or the DNS root's trailing dot.
          servername: isIP(hostname) ? undefined : hostname.replace(/\.$/, ''),
        });
        const ready = protocol === 'https:' ? 'secureConnect' : 'connect';
        const timer = setTimeout(() => {
          socket.destroy();
          fail(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' }));
        }, connectTimeoutMs);
        const onError = (err: Error) => {
          clearTimeout(timer);
          socket.destroy();
          fail(err);
        };
        socket.once('error', onError);
        socket.once(ready, () => {
          clearTimeout(timer);
          socket.removeListener('error', onError);
          if (settled) {
            socket.destroy();
            return;
          }
          settled = true;
          callback(null, socket);
        });
      },
      (err: Error) => fail(err),
    );
  };
}

const safeDispatchers = new WeakSet<Dispatcher>();

/** True only for dispatchers built by `createSafeDispatcher`. */
export function isSafeDispatcher(dispatcher: Dispatcher): boolean {
  return safeDispatchers.has(dispatcher);
}

/**
 * The production dispatcher: a plain undici Agent (no proxy, no redirect or retry interceptors)
 * whose every connection goes through the safe connector.
 */
export function createSafeDispatcher(options: SafeConnectorOptions = {}): Dispatcher {
  const agent = new Agent({
    connect: createSafeConnector(options),
    allowH2: false,
    // Short-lived pooling only; a new connection is revalidated from scratch.
    keepAliveTimeout: 4000,
    keepAliveMaxTimeout: 10_000,
  });
  safeDispatchers.add(agent);
  return agent;
}
