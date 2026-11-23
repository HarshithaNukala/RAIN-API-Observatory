import { describe, expect, it } from 'vitest';
import {
  CreateMonitorSchema,
  HEADER_LIMITS,
  MONITOR_LIMITS,
  MonitorHeaderUpdateSchema,
  MonitorListQuerySchema,
  MonitorResponseSchema,
  UpdateMonitorSchema,
  findMonitorConfigIssues,
} from './index.js';

const valid = { name: 'Payments API', url: 'https://api.example.com/health' };

const messagesFor = (schema: { safeParse: (v: unknown) => unknown }, value: unknown) => {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
  return result.success ? [] : result.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('CreateMonitorSchema', () => {
  it('applies the documented defaults', () => {
    expect(CreateMonitorSchema.parse(valid)).toEqual({
      name: 'Payments API',
      description: null,
      url: 'https://api.example.com/health',
      method: 'GET',
      expectedStatusCode: 200,
      timeoutMs: 10_000,
      latencyThresholdMs: 2000,
      checkIntervalSeconds: 300,
      allowMutatingRequests: false,
      requestBody: null,
      bodyContentType: null,
      headers: [],
    });
  });

  it('trims the name and normalises the URL', () => {
    const parsed = CreateMonitorSchema.parse({
      name: '  Orders  ',
      url: ' HTTPS://API.example.com/x#frag ',
    });
    expect(parsed).toMatchObject({ name: 'Orders', url: 'https://api.example.com/x' });
  });

  it('accepts a full POST configuration with headers', () => {
    const parsed = CreateMonitorSchema.parse({
      ...valid,
      method: 'POST',
      allowMutatingRequests: true,
      requestBody: '{"ping":true}',
      bodyContentType: 'application/json; charset=utf-8',
      headers: [{ name: 'Authorization', value: 'Bearer abc' }],
    });
    expect(parsed.headers).toHaveLength(1);
  });

  it.each([
    ['a blank name', { name: '   ' }, /name: Enter a name/],
    ['a name over 100 characters', { name: 'x'.repeat(101) }, /name: .*at most 100/],
    [
      'a description over 500 characters',
      { description: 'x'.repeat(501) },
      /description: .*at most 500/,
    ],
    ['a private URL', { url: 'http://192.168.0.10/' }, /url: Private/],
    ['an unsupported scheme', { url: 'ftp://example.com/' }, /url: Only http/],
    ['DELETE', { method: 'DELETE' }, /method:/],
    ['TRACE', { method: 'TRACE' }, /method:/],
    ['CONNECT', { method: 'CONNECT' }, /method:/],
    ['a lower-case method', { method: 'get' }, /method:/],
    ['status code 99', { expectedStatusCode: 99 }, /expectedStatusCode: .*at least 100/],
    ['status code 600', { expectedStatusCode: 600 }, /expectedStatusCode: .*at most 599/],
    [
      'a fractional status code',
      { expectedStatusCode: 200.5 },
      /expectedStatusCode: .*whole number/,
    ],
    ['a string status code', { expectedStatusCode: '200' }, /expectedStatusCode:/],
    ['a timeout below 1 s', { timeoutMs: 999 }, /timeoutMs: .*at least 1000/],
    ['a timeout above 30 s', { timeoutMs: 30_001 }, /timeoutMs: .*at most 30000/],
    ['an interval below 60 s', { checkIntervalSeconds: 59 }, /checkIntervalSeconds: .*at least 60/],
    [
      'an interval above 1 day',
      { checkIntervalSeconds: 86_401 },
      /checkIntervalSeconds: .*at most 86400/,
    ],
    ['a zero latency threshold', { latencyThresholdMs: 0 }, /latencyThresholdMs: .*at least 1/],
    [
      'a threshold above the timeout',
      { timeoutMs: 1000, latencyThresholdMs: 1500 },
      /latencyThresholdMs: .*longer than the timeout/,
    ],
    ['a body on GET', { requestBody: '{}' }, /requestBody: GET requests can't send a body/],
    ['a body on HEAD', { method: 'HEAD', requestBody: '{}' }, /requestBody: HEAD/],
    [
      'a content type without a body',
      { method: 'POST', bodyContentType: 'text/plain' },
      /bodyContentType: .*only applies/,
    ],
    [
      'a malformed content type',
      { method: 'POST', requestBody: 'x', bodyContentType: 'json' },
      /bodyContentType: Enter a media type/,
    ],
    ['an unknown property', { ownerId: 'someone-else' }, /Unrecognized key/],
  ])('rejects %s', (_label, override, expected) => {
    expect(messagesFor(CreateMonitorSchema, { ...valid, ...override }).join('\n')).toMatch(
      expected,
    );
  });

  it('accepts the exact bounds', () => {
    for (const override of [
      { timeoutMs: 1000, latencyThresholdMs: 1000 },
      { timeoutMs: 30_000 },
      { checkIntervalSeconds: 60 },
      { checkIntervalSeconds: 86_400 },
      { expectedStatusCode: 100 },
      { expectedStatusCode: 599 },
    ]) {
      expect(messagesFor(CreateMonitorSchema, { ...valid, ...override })).toEqual([]);
    }
  });

  it('limits the request body to 32 KB (32,768 bytes), measured in UTF-8', () => {
    expect(MONITOR_LIMITS.requestBodyMaxBytes).toBe(32_768);
    const post = { ...valid, method: 'POST', allowMutatingRequests: true };
    const max = MONITOR_LIMITS.requestBodyMaxBytes;
    expect(messagesFor(CreateMonitorSchema, { ...post, requestBody: 'a'.repeat(max) })).toEqual([]);
    expect(
      messagesFor(CreateMonitorSchema, { ...post, requestBody: 'a'.repeat(max + 1) })[0],
    ).toMatch(/32 KB/);
    // "é" is two bytes, so half as many characters already exceeds the limit.
    expect(
      messagesFor(CreateMonitorSchema, { ...post, requestBody: 'é'.repeat(max / 2 + 1) })[0],
    ).toMatch(/32 KB/);
  });
});

describe('monitor headers', () => {
  const withHeaders = (headers: unknown) =>
    messagesFor(CreateMonitorSchema, { ...valid, headers }).join('\n');

  it.each([
    'Host',
    'content-length',
    'Transfer-Encoding',
    'CONNECTION',
    'Upgrade',
    'Proxy-Authorization',
    'Proxy-Authenticate',
    'TE',
    'Trailer',
    'Keep-Alive',
  ])('rejects the transport-controlled header %s', (name) => {
    expect(withHeaders([{ name, value: 'x' }])).toMatch(/controlled by the HTTP client/);
  });

  it('points Content-Type at the dedicated field', () => {
    expect(withHeaders([{ name: 'Content-Type', value: 'text/plain' }])).toMatch(
      /body content type field/,
    );
  });

  it.each([
    ['a space', 'X Api Key'],
    ['a colon', 'X-Key:'],
    ['a line break', 'X-Key\r\nInjected'],
    ['non-ASCII', 'X-Clé'],
    ['parentheses', 'X-(Key)'],
  ])('rejects a header name containing %s', (_label, name) => {
    expect(withHeaders([{ name, value: 'v' }])).toMatch(/headers\.0\.name/);
  });

  it.each([
    ['CRLF injection', 'abc\r\nX-Injected: 1'],
    ['a bare line feed', 'abc\ndef'],
    ['a NUL byte', 'abc\u0000def'],
    ['only whitespace', '   '],
    ['nothing', ''],
  ])('rejects a header value with %s', (_label, value) => {
    expect(withHeaders([{ name: 'X-Api-Key', value }])).toMatch(/headers\.0\.value/);
  });

  it('enforces name and value length limits', () => {
    expect(
      withHeaders([{ name: 'X'.repeat(HEADER_LIMITS.maxNameLength + 1), value: 'v' }]),
    ).toMatch(/at most 100/);
    expect(
      withHeaders([{ name: 'X-Key', value: 'v'.repeat(HEADER_LIMITS.maxValueLength + 1) }]),
    ).toMatch(/at most 4096/);
    expect(withHeaders([{ name: 'X-Key', value: 'v'.repeat(HEADER_LIMITS.maxValueLength) }])).toBe(
      '',
    );
  });

  it('rejects duplicate names case-insensitively', () => {
    expect(
      withHeaders([
        { name: 'X-Api-Key', value: 'a' },
        { name: 'x-api-key', value: 'b' },
      ]),
    ).toMatch(/headers\.1\.name: Duplicate header "x-api-key"/);
  });

  it('rejects more than 20 headers', () => {
    const headers = Array.from({ length: 21 }, (_, i) => ({ name: `X-H-${i}`, value: 'v' }));
    expect(withHeaders(headers)).toMatch(/at most 20 headers/);
  });

  it('rejects an oversized set of headers', () => {
    const headers = Array.from({ length: 9 }, (_, i) => ({
      name: `X-H-${i}`,
      value: 'v'.repeat(4096),
    }));
    expect(withHeaders(headers)).toMatch(/too large in total/);
  });
});

describe('UpdateMonitorSchema', () => {
  it('accepts a single-field patch and leaves other fields absent', () => {
    expect(UpdateMonitorSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('distinguishes clearing the body (null) from leaving it alone (omitted)', () => {
    expect(UpdateMonitorSchema.parse({ requestBody: null })).toEqual({ requestBody: null });
    expect('requestBody' in UpdateMonitorSchema.parse({ name: 'x' })).toBe(false);
  });

  it('refuses headers, so an ordinary edit can never touch stored credentials', () => {
    expect(messagesFor(UpdateMonitorSchema, { name: 'x', headers: [] })[0]).toMatch(
      /Unrecognized key/,
    );
  });

  it('refuses server-managed fields', () => {
    for (const field of ['enabled', 'currentStatus', 'ownerId', 'nextCheckAt', 'id']) {
      expect(messagesFor(UpdateMonitorSchema, { [field]: 'x' })[0]).toMatch(/Unrecognized key/);
    }
  });

  it('rejects an empty patch', () => {
    expect(messagesFor(UpdateMonitorSchema, {})[0]).toMatch(/at least one field/);
  });

  it('applies the same field bounds as creation', () => {
    expect(messagesFor(UpdateMonitorSchema, { checkIntervalSeconds: 10 })[0]).toMatch(
      /at least 60/,
    );
    expect(messagesFor(UpdateMonitorSchema, { url: 'http://localhost/' })[0]).toMatch(
      /Local and internal/,
    );
  });
});

describe('MonitorHeaderUpdateSchema', () => {
  it('accepts upserts and removals together', () => {
    const parsed = MonitorHeaderUpdateSchema.parse({
      upsert: [{ name: 'Authorization', value: 'Bearer new' }],
      remove: ['X-Old-Key'],
    });
    expect(parsed).toEqual({
      upsert: [{ name: 'Authorization', value: 'Bearer new' }],
      remove: ['X-Old-Key'],
    });
  });

  it('accepts a removal-only update', () => {
    expect(MonitorHeaderUpdateSchema.parse({ remove: ['X-Old'] })).toEqual({
      upsert: [],
      remove: ['X-Old'],
    });
  });

  it('rejects an update that does nothing', () => {
    expect(messagesFor(MonitorHeaderUpdateSchema, {})[0]).toMatch(/at least one header/);
  });

  it('rejects upserting and removing the same header', () => {
    expect(
      messagesFor(MonitorHeaderUpdateSchema, {
        upsert: [{ name: 'X-Key', value: 'v' }],
        remove: ['x-key'],
      })[0],
    ).toMatch(/both upserted and removed/);
  });

  it('rejects an upsert without a value', () => {
    expect(messagesFor(MonitorHeaderUpdateSchema, { upsert: [{ name: 'X-Key' }] })[0]).toMatch(
      /upsert\.0\.value/,
    );
  });
});

describe('findMonitorConfigIssues', () => {
  it('returns nothing for a consistent configuration', () => {
    expect(
      findMonitorConfigIssues({
        method: 'POST',
        timeoutMs: 5000,
        latencyThresholdMs: 800,
        requestBody: '{}',
        bodyContentType: 'application/json',
        allowMutatingRequests: true,
      }),
    ).toEqual([]);
  });

  it('reports every cross-field conflict', () => {
    const issues = findMonitorConfigIssues({
      method: 'GET',
      timeoutMs: 1000,
      latencyThresholdMs: 2000,
      requestBody: '{}',
      bodyContentType: null,
      allowMutatingRequests: false,
    });
    expect(issues.map((i) => i.path)).toEqual(['requestBody', 'latencyThresholdMs']);
  });

  it.each(['POST', 'PUT', 'PATCH'] as const)(
    'requires explicit permission for %s, with or without a body',
    (method) => {
      for (const requestBody of ['{}', null]) {
        const issues = findMonitorConfigIssues({
          method,
          timeoutMs: 5000,
          latencyThresholdMs: 800,
          requestBody,
          bodyContentType: null,
          allowMutatingRequests: false,
        });
        expect(issues).toEqual([
          {
            path: 'allowMutatingRequests',
            message: `${method} monitors need explicit permission to send repeated mutating requests`,
          },
        ]);
      }
    },
  );

  it.each(['GET', 'HEAD', 'OPTIONS'] as const)('needs no permission for %s', (method) => {
    const config = {
      method,
      timeoutMs: 5000,
      latencyThresholdMs: 800,
      requestBody: null,
      bodyContentType: null,
    };
    expect(findMonitorConfigIssues({ ...config, allowMutatingRequests: false })).toEqual([]);
    expect(findMonitorConfigIssues({ ...config, allowMutatingRequests: true })).toEqual([]);
  });
});

describe('allowMutatingRequests', () => {
  const base = { name: 'Writer', url: 'https://api.example.com/items' };

  it('defaults to false and is never implied by the method', () => {
    expect(CreateMonitorSchema.parse(base).allowMutatingRequests).toBe(false);
    const result = CreateMonitorSchema.safeParse({ ...base, method: 'POST' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['allowMutatingRequests']);
  });

  it('accepts a mutating monitor only with explicit permission', () => {
    expect(
      CreateMonitorSchema.parse({ ...base, method: 'PUT', allowMutatingRequests: true }),
    ).toMatchObject({ method: 'PUT', allowMutatingRequests: true });
  });

  it('must be a real boolean, not a truthy string', () => {
    expect(
      CreateMonitorSchema.safeParse({ ...base, method: 'POST', allowMutatingRequests: 'yes' })
        .success,
    ).toBe(false);
  });
});

describe('MonitorListQuerySchema', () => {
  it('applies defaults and coerces the page size from a query string', () => {
    expect(MonitorListQuerySchema.parse({ limit: '10' })).toEqual({ state: 'all', limit: 10 });
  });

  it('bounds the page size', () => {
    expect(messagesFor(MonitorListQuerySchema, { limit: '101' })).toHaveLength(1);
    expect(messagesFor(MonitorListQuerySchema, { limit: '0' })).toHaveLength(1);
  });

  it('rejects unknown filter values', () => {
    expect(messagesFor(MonitorListQuerySchema, { state: 'archived' })).toHaveLength(1);
    expect(messagesFor(MonitorListQuerySchema, { status: 'PAUSED' })).toHaveLength(1);
  });
});

describe('MonitorResponseSchema', () => {
  it('has no field that could carry a header value', () => {
    const header = MonitorResponseSchema.shape.headers.element.shape;
    expect(Object.keys(header).sort()).toEqual(['configured', 'name', 'updatedAt']);
  });
});
