import {
  ApiErrorSchema,
  ApiFieldIssueSchema,
  dataEnvelope,
  type ApiFieldIssue,
  type DataEnvelope,
  type ErrorCode,
} from '@rain/shared';
import { z } from 'zod';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'BAD_RESPONSE';

/** One server-side validation problem, addressed to a request field such as `url`. */
export type FieldIssue = ApiFieldIssue;

const fieldIssues = z.array(ApiFieldIssueSchema);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly requestId?: string,
    /** Present on VALIDATION_ERROR responses. */
    readonly issues: FieldIssue[] = [],
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

  /** Sends with the session token, retrying once after a refresh, and throws on any non-2xx. */
  async function execute(path: string, init: RequestInit): Promise<Response> {
    const token = await options.getAccessToken();
    let res = await send(path, init, token);

    if (res.status === 401 && token) {
      const refreshed = await options.refreshAccessToken();
      if (refreshed) res = await send(path, init, refreshed);
    }
    if (res.ok) return res;

    const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => undefined));
    if (parsed.success) {
      const { code, message, requestId, details } = parsed.data.error;
      const issues = fieldIssues.safeParse(details);
      throw new ApiError(res.status, code, message, requestId, issues.success ? issues.data : []);
    }
    throw new ApiError(
      res.status,
      'BAD_RESPONSE',
      `Unexpected response from the API (${res.status})`,
    );
  }

  async function request<T extends z.ZodType>(
    path: string,
    schema: T,
    init: RequestInit,
  ): Promise<z.infer<T>> {
    const res = await execute(path, init);
    const parsed = dataEnvelope(schema).safeParse(await res.json().catch(() => undefined));
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

  /** Like `request`, but validates and returns the whole body, for responses with metadata. */
  async function requestBody<T extends z.ZodType>(
    path: string,
    schema: T,
    init: RequestInit,
  ): Promise<z.infer<T>> {
    const res = await execute(path, init);
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ApiError(
        res.status,
        'BAD_RESPONSE',
        'The API returned data in an unexpected format',
      );
    }
    return parsed.data;
  }

  const withBody = (method: string, body?: unknown): RequestInit =>
    body === undefined ? { method } : { method, body: JSON.stringify(body) };

  return {
    get: <T extends z.ZodType>(path: string, schema: T) => request(path, schema, { method: 'GET' }),
    post: <T extends z.ZodType>(path: string, schema: T, body?: unknown) =>
      request(path, schema, withBody('POST', body)),
    patch: <T extends z.ZodType>(path: string, schema: T, body: unknown) =>
      request(path, schema, withBody('PATCH', body)),
    /** PATCH whose response is validated as a whole (`{ data, meta }`), not just `data`. */
    patchWithMeta: <T extends z.ZodType>(path: string, responseSchema: T, body: unknown) =>
      requestBody(path, responseSchema, withBody('PATCH', body)),
    /** For endpoints that answer 204 No Content. */
    delete: async (path: string): Promise<void> => {
      await execute(path, { method: 'DELETE' });
    },
  };
}
