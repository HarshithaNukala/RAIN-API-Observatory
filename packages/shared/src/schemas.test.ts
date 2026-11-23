import { describe, expect, it } from 'vitest';
import { ApiErrorSchema, MeSchema, ProfileSchema, ReadinessSchema, dataEnvelope } from './index.js';

const profile = {
  id: '6f1c2c1e-6a43-4a8a-9d3c-2b7f1d0e8a11',
  displayName: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00+00:00',
};

describe('ProfileSchema', () => {
  it('accepts a valid profile', () => {
    expect(ProfileSchema.parse(profile)).toEqual(profile);
  });

  it('rejects a non-UUID id', () => {
    expect(ProfileSchema.safeParse({ ...profile, id: '123' }).success).toBe(false);
  });

  it('rejects a timestamp that is not ISO-8601', () => {
    expect(ProfileSchema.safeParse({ ...profile, createdAt: 'yesterday' }).success).toBe(false);
  });
});

describe('MeSchema envelope', () => {
  it('parses a /api/v1/me response body', () => {
    const body = { data: { id: profile.id, email: 'a@example.com', profile } };
    expect(dataEnvelope(MeSchema).parse(body)).toEqual(body);
  });

  it('allows a null email', () => {
    expect(MeSchema.safeParse({ id: profile.id, email: null, profile }).success).toBe(true);
  });
});

describe('ApiErrorSchema', () => {
  it('accepts a standard error body', () => {
    const body = { error: { code: 'UNAUTHENTICATED', message: 'Missing token', requestId: 'r1' } };
    expect(ApiErrorSchema.parse(body)).toEqual(body);
  });

  it('rejects an unknown error code', () => {
    const body = { error: { code: 'TEAPOT', message: 'no' } };
    expect(ApiErrorSchema.safeParse(body).success).toBe(false);
  });
});

describe('ReadinessSchema', () => {
  it('requires both checks', () => {
    expect(ReadinessSchema.safeParse({ status: 'ready', checks: { database: 'ok' } }).success).toBe(
      false,
    );
  });
});
