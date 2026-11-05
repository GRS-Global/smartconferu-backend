import { createHash, randomBytes } from 'node:crypto';
import { decrypt, encrypt, pkcePair } from './secrets.js';

describe('encrypt / decrypt', () => {
  const key = randomBytes(32);

  it('round-trips and never repeats a ciphertext', () => {
    const a = encrypt(key, 'JBSWY3DPEHPK3PXP');
    const b = encrypt(key, 'JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(decrypt(key, a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses a tampered ciphertext or the wrong key', () => {
    const sealed = encrypt(key, 'secret');
    const [iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    expect(() =>
      decrypt(key, [iv, tag, flipped.toString('base64url')].join('.')),
    ).toThrow();
    expect(() => decrypt(randomBytes(32), sealed)).toThrow();
  });
});

describe('pkcePair', () => {
  it('makes an S256 challenge of a 43-character verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });
});
