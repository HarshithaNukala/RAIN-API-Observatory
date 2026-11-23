/**
 * Syntax-level safety checks for a monitor's target URL. They run identically in the browser
 * form and in the API.
 *
 * This is NOT full SSRF protection: a public hostname can still resolve to a private address.
 * Resolving DNS and validating the address at connect time is the monitoring executor's job.
 * See docs/security/monitor-network-security.md.
 */
import { classifyIpAddress, parseIpv6 } from './ip-address.js';

export const MAX_MONITOR_URL_LENGTH = 2048;

export type MonitorProtocol = 'http:' | 'https:';

/** The port a URL actually connects to, with the scheme's default filled in. */
const DEFAULT_PORTS: Readonly<Record<MonitorProtocol, number>> = { 'http:': 80, 'https:': 443 };

/**
 * Ports monitors may target, per scheme. V1 allows only the standard ports. The policy is a
 * parameter so a later release can pass an administrator-controlled allowlist instead.
 */
export type MonitorPortPolicy = Readonly<Record<MonitorProtocol, readonly number[]>>;
export const DEFAULT_MONITOR_PORT_POLICY: MonitorPortPolicy = { 'http:': [80], 'https:': [443] };

/** Machine-readable codes for URL problems that clients may want to handle specially. */
export type MonitorUrlIssueCode = 'UNSUPPORTED_PORT';

export interface MonitorUrlIssue {
  message: string;
  code?: MonitorUrlIssueCode;
}

const isMonitorProtocol = (protocol: string): protocol is MonitorProtocol =>
  protocol === 'http:' || protocol === 'https:';

/**
 * The parser already drops a port equal to the scheme's default (":443" on https), so an empty
 * `port` means the default port.
 */
function effectivePort(url: URL & { protocol: MonitorProtocol }): number {
  return url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port);
}

/**
 * The destination a monitor's saved credentials belong to: scheme, normalised hostname and
 * effective port. The path and query are not part of it. Returns null for an unparseable or
 * non-HTTP URL.
 */
export function monitorOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isMonitorProtocol(url.protocol)) return null;
  const host = url.hostname.replace(/\.$/, '');
  return `${url.protocol}//${host}:${effectivePort(url as URL & { protocol: MonitorProtocol })}`;
}

/** Query parameters that conventionally carry credentials. Secrets belong in encrypted headers. */
const CREDENTIAL_QUERY_PARAMS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'api-key',
  'auth',
  'authorization',
  'bearer',
  'client_secret',
  'jwt',
  'key',
  'passwd',
  'password',
  'private_key',
  'pwd',
  'secret',
  'sig',
  'signature',
  'token',
]);

const LOCAL_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'home.arpa',
];

const PRIVATE_ADDRESS = "Private, loopback and reserved IP addresses can't be monitored";

function findHostProblem(hostname: string): string | null {
  if (hostname.startsWith('[')) {
    const address = hostname.slice(1, -1);
    const groups = parseIpv6(address);
    // A literal IPv4-mapped address in a URL is refused outright: write the IPv4 address instead.
    const mapped =
      groups !== null && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    return mapped || !classifyIpAddress(address).allowed ? PRIVATE_ADDRESS : null;
  }
  // The URL parser has already normalised hex, octal and integer IPv4 forms to dotted decimal.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return classifyIpAddress(hostname).allowed ? null : PRIVATE_ADDRESS;
  }
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (LOCAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return "Local and internal hostnames can't be monitored";
  }
  if (!host.includes('.')) {
    return 'Use a public hostname with a domain, such as api.example.com';
  }
  return null;
}

export const UNSUPPORTED_PORT_MESSAGE =
  'Only standard ports are supported: 80 for http:// and 443 for https://. Custom ports may be supported in a later release.';

/**
 * Returns the reason the URL can't be monitored, or null when it is acceptable. `portPolicy`
 * defaults to the V1 standard-ports-only policy; it is not something API callers can change.
 */
export function findMonitorUrlIssue(
  raw: string,
  portPolicy: MonitorPortPolicy = DEFAULT_MONITOR_PORT_POLICY,
): MonitorUrlIssue | null {
  const problem = (message: string, code?: MonitorUrlIssueCode): MonitorUrlIssue =>
    code ? { message, code } : { message };
  if (raw.length > MAX_MONITOR_URL_LENGTH) {
    return problem(`URL must be at most ${MAX_MONITOR_URL_LENGTH} characters`);
  }
  // Matching control characters is the point here: they are rejected before URL parsing.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    return problem('URL must not contain spaces or control characters');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return problem('Enter a valid URL, such as https://api.example.com/health');
  }
  if (!isMonitorProtocol(url.protocol)) {
    return problem('Only http:// and https:// URLs can be monitored');
  }
  if (url.username || url.password) {
    return problem('Remove the username and password from the URL and use a header instead');
  }
  if (!url.hostname) return problem('Enter a valid URL, such as https://api.example.com/health');
  const hostProblem = findHostProblem(url.hostname);
  if (hostProblem) return problem(hostProblem);
  const port = effectivePort(url as URL & { protocol: MonitorProtocol });
  if (!portPolicy[url.protocol].includes(port)) {
    return problem(UNSUPPORTED_PORT_MESSAGE, 'UNSUPPORTED_PORT');
  }
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAMS.has(name.toLowerCase())) {
      return problem(
        `Don't put credentials in the URL ("${name}"). Add them as a header instead; header values are encrypted`,
      );
    }
  }
  return null;
}

/** The message of `findMonitorUrlIssue`, for callers that only need text. */
export function findMonitorUrlProblem(raw: string): string | null {
  return findMonitorUrlIssue(raw)?.message ?? null;
}

/** Canonical form stored for a valid URL: parser-normalised, without the fragment. */
export function normalizeMonitorUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  return url.href;
}

/** Origin and path only, for logs and error messages. Never includes query strings or userinfo. */
export function sanitizeUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}
