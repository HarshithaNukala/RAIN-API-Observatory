import { MeSchema } from '@rain/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type ApiClientOptions } from './api-client';

const me = {
  id: '6f1c2c1e-6a43-4a8a-9d3c-2b7f1d0e8a11',
  email: 'a@example.com',
  profile: {
    id: '6f1c2c1e-6a43-4a8a-9d3c-2b7f1d0e8a11',
    displayName: null,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(responses: Array<Response | Error>, overrides: Partial<ApiClientOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  const options = {
    getAccessToken: vi.fn(async () => 'token-1'),
    refreshAccessToken: vi.fn(async () => 'token-2'),
    fetch,
    ...overrides,
  };
  return { api: createApiClient(options), fetch, options };
}

const authHeader = (call: unknown[] | undefined) =>
  new Headers((call?.[1] as RequestInit | undefined)?.headers).get('Authorization');

describe('createApiClient', () => {
  it('sends the bearer token and unwraps the data envelope', async () => {
    const { api, fetch } = setup([json(200, { data: me })]);
    await expect(api.get('/api/v1/me', MeSchema)).resolves.toEqual(me);
    expect(authHeader(fetch.mock.calls[0])).toBe('Bearer token-1');
  });

  it('omits the Authorization header when signed out', async () => {
    const { api, fetch } = setup([json(200, { data: me })], { getAccessToken: async () => null });
    await api.get('/api/v1/me', MeSchema);
    expect(authHeader(fetch.mock.calls[0])).toBeNull();
  });

  it('refreshes once and retries after a 401', async () => {
    const unauth = { error: { code: 'TOKEN_EXPIRED', message: 'expired', requestId: 'r1' } };
    const { api, fetch, options } = setup([json(401, unauth), json(200, { data: me })]);
    await expect(api.get('/api/v1/me', MeSchema)).resolves.toEqual(me);
    expect(options.refreshAccessToken).toHaveBeenCalledOnce();
    expect(authHeader(fetch.mock.calls[1])).toBe('Bearer token-2');
  });

  it('surfaces the error when the retry is still 401', async () => {
    const unauth = { error: { code: 'UNAUTHENTICATED', message: 'nope', requestId: 'r2' } };
    const { api, fetch } = setup([json(401, unauth), json(401, unauth)]);
    const err = await api.get('/api/v1/me', MeSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'UNAUTHENTICATED', requestId: 'r2' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry when there was no session to refresh', async () => {
    const unauth = { error: { code: 'UNAUTHENTICATED', message: 'nope' } };
    const { api, fetch, options } = setup([json(401, unauth)], {
      getAccessToken: async () => null,
    });
    await expect(api.get('/api/v1/me', MeSchema)).rejects.toMatchObject({ status: 401 });
    expect(options.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('maps standard error bodies to ApiError', async () => {
    const body = { error: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'r3' } };
    const { api } = setup([json(429, body)]);
    await expect(api.get('/api/v1/me', MeSchema)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow down',
    });
  });

  it('turns network failures into NETWORK_ERROR', async () => {
    const { api } = setup([new TypeError('Failed to fetch')]);
    await expect(api.get('/api/v1/me', MeSchema)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('rejects responses that do not match the shared contract', async () => {
    const { api } = setup([json(200, { data: { id: 'not-a-uuid' } })]);
    await expect(api.get('/api/v1/me', MeSchema)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('handles non-JSON error pages (e.g. a proxy 502)', async () => {
    const { api } = setup([new Response('<html>Bad gateway</html>', { status: 502 })]);
    await expect(api.get('/api/v1/me', MeSchema)).rejects.toMatchObject({
      status: 502,
      code: 'BAD_RESPONSE',
    });
  });
});

describe('createApiClient write methods', () => {
  const sent = (call: unknown[] | undefined) => {
    const init = call?.[1] as RequestInit;
    return {
      method: init.method,
      body: init.body,
      contentType: new Headers(init.headers).get('Content-Type'),
    };
  };

  it('POST sends a JSON body and unwraps the response', async () => {
    const { api, fetch } = setup([json(201, { data: me })]);
    await expect(api.post('/api/v1/things', MeSchema, { name: 'x' })).resolves.toEqual(me);
    expect(sent(fetch.mock.calls[0])).toEqual({
      method: 'POST',
      body: '{"name":"x"}',
      contentType: 'application/json',
    });
  });

  it('POST without a body sends no body or Content-Type', async () => {
    const { api, fetch } = setup([json(200, { data: me })]);
    await api.post('/api/v1/things/1/pause', MeSchema);
    expect(sent(fetch.mock.calls[0])).toEqual({
      method: 'POST',
      body: undefined,
      contentType: null,
    });
  });

  it('PATCH sends the patch as JSON', async () => {
    const { api, fetch } = setup([json(200, { data: me })]);
    await api.patch('/api/v1/things/1', MeSchema, { name: 'y' });
    expect(sent(fetch.mock.calls[0])).toMatchObject({ method: 'PATCH', body: '{"name":"y"}' });
  });

  it('DELETE resolves on 204 without reading a body', async () => {
    const { api, fetch } = setup([new Response(null, { status: 204 })]);
    await expect(api.delete('/api/v1/things/1')).resolves.toBeUndefined();
    expect(sent(fetch.mock.calls[0]).method).toBe('DELETE');
  });

  it('DELETE refreshes once after a 401 like reads do', async () => {
    const unauth = { error: { code: 'TOKEN_EXPIRED', message: 'expired' } };
    const { api, fetch } = setup([json(401, unauth), new Response(null, { status: 204 })]);
    await api.delete('/api/v1/things/1');
    expect(authHeader(fetch.mock.calls[1])).toBe('Bearer token-2');
  });

  it('exposes field-level issues from VALIDATION_ERROR responses', async () => {
    const body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId: 'r4',
        details: [{ path: 'url', message: 'Enter a valid URL' }],
      },
    };
    const { api } = setup([json(400, body)]);
    const err = await api.post('/api/v1/things', MeSchema, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      issues: [{ path: 'url', message: 'Enter a valid URL' }],
    });
  });

  it('ignores details that are not field issues', async () => {
    const body = { error: { code: 'CONFLICT', message: 'conflict', details: { other: true } } };
    const { api } = setup([json(409, body)]);
    await expect(api.delete('/api/v1/things/1')).rejects.toMatchObject({
      code: 'CONFLICT',
      issues: [],
    });
  });
});
