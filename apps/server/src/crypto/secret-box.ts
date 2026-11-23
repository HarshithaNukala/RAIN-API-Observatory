import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // The GCM-recommended nonce size.
const AUTH_TAG_BYTES = 16;

/** Everything needed to decrypt one value, each part base64-encoded for storage. */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Deliberately carries no detail: callers must not learn why authentication failed. */
export class DecryptionError extends Error {
  constructor() {
    super('Stored secret could not be decrypted');
    this.name = 'DecryptionError';
  }
}

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export interface SecretBox {
  readonly currentKeyVersion: number;
  /**
   * @param context Bound to the ciphertext as additional authenticated data. Decryption only
   *   succeeds with the same context, so a ciphertext copied onto another row is rejected.
   */
  encrypt(plaintext: string, context: string): SealedSecret;
  decrypt(sealed: SealedSecret, context: string): string;
}

/** Parses a base64-encoded 256-bit key. Never logs or echoes the key material. */
export function parseEncryptionKey(encoded: string): Buffer {
  const trimmed = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new EncryptionKeyError('must be standard base64');
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(`must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`);
  }
  if (key.every((byte) => byte === key[0])) {
    throw new EncryptionKeyError('must be random, not a repeated byte');
  }
  return key;
}

export function createSecretBox(options: {
  currentVersion: number;
  /** Every key that may be needed to decrypt existing rows, by version. */
  keys: ReadonlyMap<number, Buffer>;
}): SecretBox {
  const currentKey = options.keys.get(options.currentVersion);
  if (!currentKey) {
    throw new EncryptionKeyError(`no key supplied for current version ${options.currentVersion}`);
  }
  for (const [version, key] of options.keys) {
    if (key.length !== KEY_BYTES) {
      throw new EncryptionKeyError(`key version ${version} is not ${KEY_BYTES} bytes`);
    }
  }

  return {
    currentKeyVersion: options.currentVersion,

    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, currentKey, iv, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        keyVersion: options.currentVersion,
      };
    },

    decrypt(sealed, context) {
      const key = options.keys.get(sealed.keyVersion);
      const iv = Buffer.from(sealed.iv, 'base64');
      const authTag = Buffer.from(sealed.authTag, 'base64');
      // Fail closed on anything unexpected rather than attempting a weaker decryption.
      if (!key || iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new DecryptionError();
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(authTag);
        return Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new DecryptionError();
      }
    },
  };
}
