import { describe, expect, it } from 'vitest';
import { classifyIpAddress, parseIpv4, parseIpv6 } from './ip-address.js';

const verdict = (address: string) => {
  const r = classifyIpAddress(address);
  return r.allowed ? 'ALLOWED' : r.reason;
};

describe('classifyIpAddress — IPv4', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.0',
    '169.253.255.255',
    '192.169.0.1',
    '223.255.255.255',
  ])('allows the public address %s', (address) => {
    expect(verdict(address)).toBe('ALLOWED');
  });

  it.each([
    ['0.0.0.0', 'UNSPECIFIED'],
    ['0.1.2.3', 'RESERVED'],
    ['127.0.0.1', 'LOOPBACK'],
    ['127.255.255.254', 'LOOPBACK'],
    ['10.0.0.1', 'PRIVATE'],
    ['10.255.255.255', 'PRIVATE'],
    ['172.16.0.1', 'PRIVATE'],
    ['172.31.255.255', 'PRIVATE'],
    ['192.168.0.1', 'PRIVATE'],
    ['100.64.0.1', 'CARRIER_GRADE_NAT'],
    ['100.127.255.255', 'CARRIER_GRADE_NAT'],
    ['169.254.0.1', 'LINK_LOCAL'],
    ['169.254.169.254', 'LINK_LOCAL'],
    ['192.0.0.8', 'RESERVED'],
    ['192.0.2.10', 'DOCUMENTATION'],
    ['198.51.100.10', 'DOCUMENTATION'],
    ['203.0.113.10', 'DOCUMENTATION'],
    ['192.88.99.1', 'TRANSLATION'],
    ['198.18.0.1', 'BENCHMARKING'],
    ['198.19.255.255', 'BENCHMARKING'],
    ['224.0.0.1', 'MULTICAST'],
    ['239.255.255.255', 'MULTICAST'],
    ['240.0.0.1', 'RESERVED'],
    ['255.255.255.255', 'RESERVED'],
  ])('blocks %s as %s', (address, reason) => {
    expect(verdict(address)).toBe(reason);
  });

  it.each(['010.0.0.1', '127.1', '1.2.3', '256.1.1.1', '1.2.3.4.5', ' 8.8.8.8', '0x7f.0.0.1'])(
    'refuses the ambiguous or malformed form %j',
    (address) => {
      expect(verdict(address)).toBe('INVALID');
    },
  );
});

describe('classifyIpAddress — IPv6', () => {
  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e'])(
    'allows the global unicast address %s',
    (address) => {
      expect(verdict(address)).toBe('ALLOWED');
    },
  );

  it.each([
    ['::', 'UNSPECIFIED'],
    ['::1', 'LOOPBACK'],
    ['0:0:0:0:0:0:0:1', 'LOOPBACK'],
    ['fe80::1', 'LINK_LOCAL'],
    ['febf::1', 'LINK_LOCAL'],
    ['fec0::1', 'LINK_LOCAL'],
    ['fc00::1', 'UNIQUE_LOCAL'],
    ['fd12:3456:789a::1', 'UNIQUE_LOCAL'],
    ['ff02::1', 'MULTICAST'],
    ['ff0e::1', 'MULTICAST'],
    ['64:ff9b::a00:1', 'TRANSLATION'],
    ['64:ff9b:1::1', 'TRANSLATION'],
    ['2002:7f00:1::', 'TRANSLATION'],
    ['2001::1', 'TRANSLATION'],
    ['2001:db8::1', 'DOCUMENTATION'],
    ['3fff::1', 'DOCUMENTATION'],
    ['2001:2::1', 'BENCHMARKING'],
    ['2001:10::1', 'RESERVED'],
    ['2001:20::1', 'RESERVED'],
    // 2001::/23 is blocked as a whole, conservatively, including AS112 (a DNS sink).
    ['2001:4:112::1', 'RESERVED'],
    ['100::1', 'NOT_GLOBAL_UNICAST'],
    ['::10.0.0.1', 'NOT_GLOBAL_UNICAST'],
    ['4000::1', 'NOT_GLOBAL_UNICAST'],
    ['::2', 'NOT_GLOBAL_UNICAST'],
  ])('blocks %s as %s', (address, reason) => {
    expect(verdict(address)).toBe(reason);
  });

  it.each([
    ['::ffff:127.0.0.1', 'LOOPBACK'],
    ['::ffff:7f00:1', 'LOOPBACK'],
    ['::ffff:10.1.2.3', 'PRIVATE'],
    ['::ffff:169.254.169.254', 'LINK_LOCAL'],
    ['0:0:0:0:0:ffff:192.168.1.1', 'PRIVATE'],
  ])('normalises the IPv4-mapped address %s and blocks it as %s', (address, reason) => {
    expect(verdict(address)).toBe(reason);
  });

  it('allows an IPv4-mapped address that carries a public IPv4 address', () => {
    expect(verdict('::ffff:8.8.8.8')).toBe('ALLOWED');
  });

  it('ignores an IPv6 zone index when classifying', () => {
    expect(verdict('fe80::1%eth0')).toBe('LINK_LOCAL');
  });

  it.each([
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    'gggg::1',
    '12345::1',
    ':::',
    '[::1]',
    'example.com',
    '',
  ])('refuses the malformed address %j', (address) => {
    expect(verdict(address)).toBe('INVALID');
  });
});

describe('parsers', () => {
  it('expands compressed IPv6 and embedded IPv4 tails', () => {
    expect(parseIpv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('accepts only strict dotted-decimal IPv4', () => {
    expect(parseIpv4('192.168.0.1')).toEqual([192, 168, 0, 1]);
    expect(parseIpv4('192.168.000.1')).toBeNull();
  });
});
