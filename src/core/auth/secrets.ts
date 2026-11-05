import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/** AES-256-GCM, output "iv.tag.ciphertext" (base64url). For secrets we must read back (TOTP). */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString('base64url'))
    .join('.');
}

export function decrypt(key: Buffer, sealed: string): string {
  const [iv, tag, data] = sealed
    .split('.')
    .map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}

/** PKCE (RFC 7636): a random verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

/** An unguessable token for links and refresh tokens (256 bits, URL-safe). */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** A 6-digit code for typing in by hand. */
export const randomCode = (): string =>
  randomInt(0, 1_000_000).toString().padStart(6, '0');

/** For high-entropy tokens: a plain SHA-256 is enough and lets us look the token up by hash. */
export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

/** For low-entropy codes: keyed, so a leaked table can't be brute-forced offline. */
export const hmac = (secret: string, value: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Emails are stored and compared in one form. */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();
