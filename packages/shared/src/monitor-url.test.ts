import { describe, expect, it } from 'vitest';
import {
  findMonitorUrlIssue,
  findMonitorUrlProblem,
  monitorOrigin,
  normalizeMonitorUrl,
  sanitizeUrlForLog,
} from './monitor-url.js';

describe('findMonitorUrlProblem', () => {
  it.each([
    'https://api.example.com/health',
    'http://api.example.com/v1/status?region=eu&verbose=1',
    'https://sub.domain.example.co.uk/',
    'https://8.8.8.8/dns-query',
    'https://93.184.216.34/',
    'https://[2606:4700:4700::1111]/',
    'https://xn--bcher-kva.example/',
  ])('accepts %s', (url) => {
    expect(findMonitorUrlProblem(url)).toBeNull();
  });

  it.each([
    ['not a URL', 'just some words'],
    ['a relative path', '/health'],
    ['a missing scheme', 'api.example.com/health'],
    ['an empty host', 'https:///path'],
    ['whitespace inside', 'https://api.example.com/a b'],
    ['a line break', 'https://api.example.com/\r\nHost: evil'],
  ])('rejects %s as malformed', (_label, url) => {
    expect(findMonitorUrlProblem(url)).toEqual(expect.any(String));
  });

  it.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'gopher://example.com/',
    'ws://example.com/',
  ])('rejects the unsupported scheme in %s', (url) => {
    expect(findMonitorUrlProblem(url)).toMatch(/Only http/);
  });

  it('rejects embedded credentials', () => {
    expect(findMonitorUrlProblem('https://user:pass@api.example.com/')).toMatch(
      /username and password/,
    );
    expect(findMonitorUrlProblem('https://token@api.example.com/')).toMatch(
      /username and password/,
    );
  });

  it.each([
    'http://localhost/',
    'http://localhost:3000/health',
    'http://LOCALHOST/',
    'http://api.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://service.corp/',
    'http://router.lan/',
    'http://nas.home.arpa/',
    'http://localhost./',
  ])('rejects the local hostname %s', (url) => {
    expect(findMonitorUrlProblem(url)).toMatch(/Local and internal/);
  });

  it('rejects single-label hostnames', () => {
    expect(findMonitorUrlProblem('http://backend/')).toMatch(/public hostname/);
  });

  it.each([
    ['loopback', 'http://127.0.0.1/'],
    ['loopback range', 'http://127.255.255.254/'],
    ['"this network"', 'http://0.0.0.0/'],
    ['10/8', 'http://10.0.0.5/'],
    ['172.16/12', 'http://172.16.0.1/'],
    ['172.31 edge', 'http://172.31.255.255/'],
    ['192.168/16', 'http://192.168.1.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['carrier-grade NAT', 'http://100.64.0.1/'],
    ['benchmarking', 'http://198.18.0.1/'],
    ['documentation range', 'http://203.0.113.10/'],
    ['multicast', 'http://224.0.0.1/'],
    ['reserved', 'http://240.0.0.1/'],
    ['broadcast', 'http://255.255.255.255/'],
    ['decimal integer loopback', 'http://2130706433/'],
    ['hex loopback', 'http://0x7f000001/'],
    ['octal loopback', 'http://0177.0.0.1/'],
    ['short-form loopback', 'http://127.1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unspecified', 'http://[::]/'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped private', 'http://[::ffff:10.0.0.1]/'],
    ['IPv4-compatible', 'http://[::10.0.0.1]/'],
    ['unique local', 'http://[fd12:3456:789a::1]/'],
    ['link-local', 'http://[fe80::1]/'],
    ['multicast v6', 'http://[ff02::1]/'],
    ['NAT64 embedding', 'http://[64:ff9b::7f00:1]/'],
    ['6to4 embedding', 'http://[2002:7f00:1::]/'],
    ['IPv6 documentation', 'http://[2001:db8::1]/'],
  ])('rejects the %s address %s', (_label, url) => {
    expect(findMonitorUrlProblem(url)).toMatch(/Private, loopback and reserved/);
  });

  it('does not reject public addresses next to private ranges', () => {
    for (const url of [
      'http://172.32.0.1/',
      'http://11.0.0.1/',
      'http://100.128.0.1/',
      'http://169.253.1.1/',
    ]) {
      expect(findMonitorUrlProblem(url)).toBeNull();
    }
  });

  it.each(['api_key', 'apikey', 'token', 'access_token', 'password', 'secret', 'KEY', 'Signature'])(
    'rejects the credential-bearing query parameter %s',
    (param) => {
      const problem = findMonitorUrlProblem(`https://api.example.com/v1?page=2&${param}=abc123`);
      expect(problem).toMatch(/credentials in the URL/);
      expect(problem).not.toContain('abc123');
    },
  );

  it('rejects URLs over the length limit', () => {
    expect(findMonitorUrlProblem(`https://api.example.com/${'a'.repeat(2048)}`)).toMatch(
      /at most 2048/,
    );
  });
});

describe('port policy', () => {
  it.each([
    'https://api.example.com/',
    'https://api.example.com:443/',
    'http://api.example.com/',
    'http://api.example.com:80/',
    'HTTPS://API.EXAMPLE.COM:443/health',
  ])('accepts the standard port in %s', (url) => {
    expect(findMonitorUrlIssue(url)).toBeNull();
  });

  it.each([
    'https://api.example.com:3000/',
    'http://api.example.com:8080/',
    'https://api.example.com:8443/',
    'https://api.example.com:80/',
    'http://api.example.com:443/',
    'http://api.example.com:0/',
    'https://api.example.com:65535/',
    'https://93.184.216.34:8443/',
    'https://[2606:4700:4700::1111]:8443/',
  ])('rejects the non-standard port in %s with UNSUPPORTED_PORT', (url) => {
    expect(findMonitorUrlIssue(url)).toEqual({
      code: 'UNSUPPORTED_PORT',
      message: expect.stringMatching(/80 for http:\/\/ and 443 for https:\/\//),
    });
  });

  it('cannot be bypassed with port-like query parameters or paths', () => {
    expect(findMonitorUrlIssue('https://api.example.com/:8443?port=8443')).toBeNull();
    expect(findMonitorUrlIssue('https://api.example.com:8443/?port=443')).toMatchObject({
      code: 'UNSUPPORTED_PORT',
    });
  });

  it('reports private addresses before ports, so the more serious problem is shown', () => {
    expect(findMonitorUrlIssue('http://localhost:8080/')).toEqual({
      message: expect.stringMatching(/Local and internal/),
    });
  });

  it('accepts an explicitly wider policy for a future administrator allowlist', () => {
    const policy = { 'http:': [80], 'https:': [443, 8443] } as const;
    expect(findMonitorUrlIssue('https://api.example.com:8443/', policy)).toBeNull();
    expect(findMonitorUrlIssue('https://api.example.com:9443/', policy)).toMatchObject({
      code: 'UNSUPPORTED_PORT',
    });
  });
});

describe('monitorOrigin', () => {
  it.each([
    ['https://api.example.com/users', 'https://api.example.com/orders'],
    ['https://api.example.com/a?x=1', 'https://api.example.com/b?y=2'],
    ['https://api.example.com/', 'https://api.example.com:443/'],
    ['http://api.example.com/', 'http://api.example.com:80/'],
    ['https://API.Example.COM/', 'https://api.example.com/'],
    ['https://api.example.com./', 'https://api.example.com/'],
  ])('treats %s and %s as the same origin', (a, b) => {
    expect(monitorOrigin(a)).toBe(monitorOrigin(b));
  });

  it.each([
    ['https://api.example.com', 'https://other-api.com'],
    ['https://api.example.com', 'http://api.example.com'],
    ['https://api.example.com', 'https://api.example.com:8443'],
    ['https://api.example.com', 'https://eu.api.example.com'],
  ])('treats %s and %s as different origins', (a, b) => {
    expect(monitorOrigin(a)).not.toBe(monitorOrigin(b));
  });

  it('spells out the effective port', () => {
    expect(monitorOrigin('https://api.example.com/x')).toBe('https://api.example.com:443');
    expect(monitorOrigin('http://api.example.com/x')).toBe('http://api.example.com:80');
  });

  it('returns null for URLs that cannot be monitored at all', () => {
    expect(monitorOrigin('not a url')).toBeNull();
    expect(monitorOrigin('ftp://files.example.com/')).toBeNull();
  });
});

describe('normalizeMonitorUrl', () => {
  it('lower-cases scheme and host and drops the fragment', () => {
    expect(normalizeMonitorUrl('HTTPS://API.Example.com/Path?q=1#section')).toBe(
      'https://api.example.com/Path?q=1',
    );
  });
});

describe('sanitizeUrlForLog', () => {
  it('drops the query string and userinfo', () => {
    expect(sanitizeUrlForLog('https://u:p@api.example.com:8443/v1/x?session=abc#h')).toBe(
      'https://api.example.com:8443/v1/x',
    );
  });

  it('never echoes unparseable input', () => {
    expect(sanitizeUrlForLog('secret garbage')).toBe('[invalid URL]');
  });
});
