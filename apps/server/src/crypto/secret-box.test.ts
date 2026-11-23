import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  EncryptionKeyError,
  createSecretBox,
  parseEncryptionKey,
  type SealedSecret,
} from './secret-box.js';

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const box = createSecretBox({ currentVersion: 1, keys: new Map([[1, key1]]) });
const CONTEXT = 'monitor-header:6f1c2c1e-6a43-4a8a-9d3c-2b7f1d0e8a11:authorization';

const flipFirstByte = (base64: string) => {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] = bytes[0]! ^ 0xff;
  return bytes.toString('base64');
};

describe('SecretBox', () => {
  it('round-trips a secret', () => {
    const sealed = box.encrypt('Bearer s3cr3t-tøken ✓', CONTEXT);
    expect(box.decrypt(sealed, CONTEXT)).toBe('Bearer s3cr3t-tøken ✓');
  });

  it('round-trips an empty string and a 64 KB body', () => {
    expect(box.decrypt(box.encrypt('', CONTEXT), CONTEXT)).toBe('');
    const big = 'x'.repeat(64 * 1024);
    expect(box.decrypt(box.encrypt(big, CONTEXT), CONTEXT)).toBe(big);
  });

  it('never stores the plaintext in any sealed field', () => {
    const sealed = box.encrypt('super-secret-value', CONTEXT);
    const stored = JSON.stringify(sealed);
    expect(stored).not.toContain('super-secret-value');
    expect(stored).not.toContain(Buffer.from('super-secret-value').toString('base64'));
    expect(sealed.keyVersion).toBe(1);
  });

  it('uses a fresh 96-bit IV for every encryption', () => {
    const sealed = Array.from({ length: 500 }, () => box.encrypt('same plaintext', CONTEXT));
    expect(new Set(sealed.map((s) => s.iv)).size).toBe(500);
    expect(new Set(sealed.map((s) => s.ciphertext)).size).toBe(500);
    expect(Buffer.from(sealed[0]!.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(sealed[0]!.authTag, 'base64')).toHaveLength(16);
  });

  it.each(['ciphertext', 'iv', 'authTag'] as const)('rejects a tampered %s', (field) => {
    const sealed = box.encrypt('Bearer abc', CONTEXT);
    const tampered: SealedSecret = { ...sealed, [field]: flipFirstByte(sealed[field]) };
    expect(() => box.decrypt(tampered, CONTEXT)).toThrow(DecryptionError);
  });

  it('rejects a truncated authentication tag', () => {
    const sealed = box.encrypt('Bearer abc', CONTEXT);
    const short = Buffer.from(sealed.authTag, 'base64').subarray(0, 8).toString('base64');
    expect(() => box.decrypt({ ...sealed, authTag: short }, CONTEXT)).toThrow(DecryptionError);
  });

  it('rejects a ciphertext moved to a different context', () => {
    const sealed = box.encrypt('Bearer abc', CONTEXT);
    expect(() => box.decrypt(sealed, CONTEXT.replace('authorization', 'x-api-key'))).toThrow(
      DecryptionError,
    );
  });

  it('fails closed with the wrong key', () => {
    const other = createSecretBox({ currentVersion: 1, keys: new Map([[1, key2]]) });
    expect(() => other.decrypt(box.encrypt('Bearer abc', CONTEXT), CONTEXT)).toThrow(
      DecryptionError,
    );
  });

  it('fails closed for an unknown key version', () => {
    const sealed = box.encrypt('Bearer abc', CONTEXT);
    expect(() => box.decrypt({ ...sealed, keyVersion: 7 }, CONTEXT)).toThrow(DecryptionError);
  });

  it('gives no detail about why decryption failed', () => {
    const sealed = box.encrypt('Bearer abc', CONTEXT);
    try {
      box.decrypt({ ...sealed, authTag: flipFirstByte(sealed.authTag) }, CONTEXT);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe('Stored secret could not be decrypted');
      expect((err as Error).cause).toBeUndefined();
    }
  });

  it('decrypts old versions after rotation and encrypts with the new one', () => {
    const old = box.encrypt('legacy secret', CONTEXT);
    const rotated = createSecretBox({
      currentVersion: 2,
      keys: new Map([
        [1, key1],
        [2, key2],
      ]),
    });
    expect(rotated.decrypt(old, CONTEXT)).toBe('legacy secret');
    const fresh = rotated.encrypt('new secret', CONTEXT);
    expect(fresh.keyVersion).toBe(2);
    expect(() => box.decrypt(fresh, CONTEXT)).toThrow(DecryptionError);
  });

  it('refuses to start without the current key', () => {
    expect(() => createSecretBox({ currentVersion: 2, keys: new Map([[1, key1]]) })).toThrow(
      EncryptionKeyError,
    );
  });
});

describe('parseEncryptionKey', () => {
  it('accepts a base64-encoded 32-byte key', () => {
    expect(parseEncryptionKey(key1.toString('base64'))).toEqual(key1);
  });

  it.each([
    ['a 16-byte key', randomBytes(16).toString('base64')],
    ['a 33-byte key', randomBytes(33).toString('base64')],
    ['hex instead of base64', randomBytes(32).toString('hex')],
    ['a passphrase', 'correct horse battery staple'],
    ['base64url', `${'-_'.repeat(21)}-=`],
    ['an all-zero key', Buffer.alloc(32).toString('base64')],
    ['nothing', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => parseEncryptionKey(value)).toThrow(EncryptionKeyError);
  });

  it('never includes key material in the error', () => {
    const bad = randomBytes(16).toString('base64');
    expect(() => parseEncryptionKey(bad)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(bad) }),
    );
  });
});
