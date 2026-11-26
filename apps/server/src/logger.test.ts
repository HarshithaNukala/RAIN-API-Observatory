import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ service: 'api', level: 'info', destination }), lines };
}

describe('createLogger redaction', () => {
  it('redacts Authorization and Cookie request headers', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      req: { headers: { authorization: 'Bearer eyJhbGciOi.secret.token', cookie: 'sb=abc' } },
    });
    const out = lines.join('');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).not.toContain('sb=abc');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts nested secret-looking fields', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      ctx: {
        password: 'hunter2',
        access_token: 'tok',
        databaseUrl: 'postgres://x',
        GEMINI_API_KEY: 'AIzaSySecret123',
        MONGODB_URI: 'mongodb+srv://user:pass@cluster',
      },
      req: { headers: { 'x-goog-api-key': 'AIzaSyHeaderSecret' } },
    });
    const out = lines.join('');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('"tok"');
    expect(out).not.toContain('postgres://x');
    expect(out).not.toContain('AIzaSySecret123');
    expect(out).not.toContain('mongodb+srv://');
    expect(out).not.toContain('AIzaSyHeaderSecret');
  });

  it('tags every line with the service name', () => {
    const { logger, lines } = captureLogger();
    logger.info('hello');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ service: 'api', msg: 'hello' });
  });
});
