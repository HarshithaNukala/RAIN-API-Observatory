import { ApiErrorSchema, dataEnvelope, type DataEnvelope, type ErrorCode } from '@rain/shared';
import type { z } from 'zod';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'BAD_RESPONSE';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  getAccessToken: () => Promise<string | null>;
  /** Forces a token refresh; returns the new token, or null if the session is gone. */
  refreshAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl ?? '';

  async function send(path: string, init: RequestInit, token: string | null): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    try {
      return await doFetch(`${baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the RAIN API. Check your connection.',
      );
    }
  }

  async function request<T extends z.ZodType>(
    path: string,
    schema: T,
    init: RequestInit = {},
  ): Promise<z.infer<T>> {
    const token = await options.getAccessToken();
    let res = await send(path, init, token);

    if (res.status === 401 && token) {
      const refreshed = await options.refreshAccessToken();
      if (refreshed) res = await send(path, init, refreshed);
    }

    const body: unknown = await res.json().catch(() => undefined);

    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(body);
      if (parsed.success) {
        const { code, message, requestId } = parsed.data.error;
        throw new ApiError(res.status, code, message, requestId);
      }
      throw new ApiError(
        res.status,
        'BAD_RESPONSE',
        `Unexpected response from the API (${res.status})`,
      );
    }

    const parsed = dataEnvelope(schema).safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        res.status,
        'BAD_RESPONSE',
        'The API returned data in an unexpected format',
      );
    }
    // TypeScript cannot resolve Zod's object output type while T is still generic, so
    // name the already-validated shape explicitly.
    return (parsed.data as DataEnvelope<z.infer<T>>).data;
  }

  return {
    get: <T extends z.ZodType>(path: string, schema: T) => request(path, schema, { method: 'GET' }),
  };
}
