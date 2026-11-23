/**
 * IP address classification, shared by registration-time URL checks and the connection-time SSRF
 * guard so both apply exactly the same rules.
 *
 * Only globally routable unicast addresses are allowed. IPv6 is allowlisted to global unicast
 * (2000::/3) with known non-public blocks inside it removed, so new or unusual reserved ranges are
 * rejected by default. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by the IPv4 address
 * they carry.
 */

export type IpBlockReason =
  | 'INVALID'
  | 'UNSPECIFIED'
  | 'LOOPBACK'
  | 'PRIVATE'
  | 'LINK_LOCAL'
  | 'CARRIER_GRADE_NAT'
  | 'MULTICAST'
  | 'RESERVED'
  | 'DOCUMENTATION'
  | 'BENCHMARKING'
  | 'UNIQUE_LOCAL'
  | 'TRANSLATION'
  | 'NOT_GLOBAL_UNICAST';

export type IpClassification =
  | { allowed: true; family: 4 | 6; address: string }
  | { allowed: false; family: 4 | 6 | null; reason: IpBlockReason };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strict dotted-decimal IPv4 (no leading zeros, no shorthand) to its four octets. */
export function parseIpv4(address: string): [number, number, number, number] | null {
  const match = IPV4.exec(address);
  if (!match) return null;
  const parts = match.slice(1).map((part) => (/^(0|[1-9]\d*)$/.test(part!) ? Number(part) : -1));
  return parts.every((n) => n >= 0 && n <= 255)
    ? (parts as [number, number, number, number])
    : null;
}

/** An IPv6 address (no brackets, optional embedded IPv4 tail, optional zone) to 8 groups. */
export function parseIpv6(raw: string): number[] | null {
  const address = raw.replace(/%.*$/, '').toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(address) || !address.includes(':')) return null;

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes its two 16-bit groups.
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const o = parseIpv4(last);
    if (!o) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const left = split(halves[0] ?? '');
  const right = halves.length === 2 ? split(halves[1] ?? '') : [];
  if ([...left, ...right].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;

  const toNumbers = (groups: string[]) => groups.map((g) => parseInt(g, 16));
  if (halves.length === 1) return left.length === 8 ? toNumbers(left) : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...toNumbers(left), ...Array<number>(missing).fill(0), ...toNumbers(right)];
}

function classifyIpv4(o: readonly number[]): IpBlockReason | null {
  const [a = 0, b = 0, c = 0] = o;
  if (a === 0) return o.every((x) => x === 0) ? 'UNSPECIFIED' : 'RESERVED'; // 0.0.0.0/8
  if (a === 127) return 'LOOPBACK';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'PRIVATE';
  }
  if (a === 100 && b >= 64 && b <= 127) return 'CARRIER_GRADE_NAT'; // 100.64.0.0/10
  if (a === 169 && b === 254) return 'LINK_LOCAL'; // includes cloud metadata 169.254.169.254
  if (a === 192 && b === 0 && c === 0) return 'RESERVED'; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'DOCUMENTATION';
  if (a === 198 && b === 51 && c === 100) return 'DOCUMENTATION';
  if (a === 203 && b === 0 && c === 113) return 'DOCUMENTATION';
  if (a === 192 && b === 88 && c === 99) return 'TRANSLATION'; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'BENCHMARKING';
  if (a >= 224 && a <= 239) return 'MULTICAST';
  if (a >= 240) return 'RESERVED'; // 240.0.0.0/4 and 255.255.255.255 broadcast
  return null;
}

function classifyIpv6(g: readonly number[]): IpBlockReason | null {
  const [g0 = 0, g1 = 0, g2 = 0] = g;
  if (g.every((x) => x === 0)) return 'UNSPECIFIED';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'LOOPBACK';
  if ((g0 & 0xff00) === 0xff00) return 'MULTICAST';
  if ((g0 & 0xfe00) === 0xfc00) return 'UNIQUE_LOCAL';
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return 'LINK_LOCAL';
  if (g0 === 0x64 && g1 === 0xff9b) return 'TRANSLATION'; // NAT64 64:ff9b::/96 and ::/48
  // Global unicast is 2000::/3; everything else (including ::/8 and 100::/64) is not public.
  if ((g0 & 0xe000) !== 0x2000) return 'NOT_GLOBAL_UNICAST';
  if (g0 === 0x2002) return 'TRANSLATION'; // 6to4 2002::/16, can embed any IPv4
  if (g0 === 0x2001 && g1 === 0xdb8) return 'DOCUMENTATION'; // 2001:db8::/32
  if (g0 === 0x3fff && g1 <= 0x0fff) return 'DOCUMENTATION'; // 3fff::/20
  if (g0 === 0x2001 && g1 < 0x200) {
    // 2001::/23, IETF protocol assignments: Teredo (2001::/32), benchmarking (2001:2::/48),
    // ORCHID (2001:10::/28, 2001:20::/28) and others. Blocked as a whole, conservatively.
    if (g1 === 0) return 'TRANSLATION';
    if (g1 === 0x2 && g2 === 0) return 'BENCHMARKING';
    return 'RESERVED';
  }
  return null;
}

/** Classifies a bare IPv4 or IPv6 address (no brackets, no port). */
export function classifyIpAddress(address: string): IpClassification {
  const v4 = parseIpv4(address);
  if (v4) {
    const reason = classifyIpv4(v4);
    return reason ? { allowed: false, family: 4, reason } : { allowed: true, family: 4, address };
  }
  const v6 = parseIpv6(address);
  if (!v6) return { allowed: false, family: null, reason: 'INVALID' };
  // IPv4-mapped (::ffff:a.b.c.d): judge the IPv4 address it actually reaches.
  if (v6.slice(0, 5).every((x) => x === 0) && v6[5] === 0xffff) {
    const mapped = [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff];
    const reason = classifyIpv4(mapped);
    return reason ? { allowed: false, family: 6, reason } : { allowed: true, family: 6, address };
  }
  const reason = classifyIpv6(v6);
  return reason ? { allowed: false, family: 6, reason } : { allowed: true, family: 6, address };
}
