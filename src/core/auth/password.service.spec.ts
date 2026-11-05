import bcrypt from 'bcryptjs';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const stored = await passwords.hash('correct horse battery');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(
      passwords.verify(stored, 'correct horse battery'),
    ).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    await expect(passwords.verify(stored, 'wrong')).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('verifies bcrypt hashes from the old system and asks for a rehash', async () => {
    const stored = await bcrypt.hash('from supabase', 4);
    await expect(passwords.verify(stored, 'from supabase')).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
    await expect(passwords.verify(stored, 'nope')).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('rejects any password when there is no hash (SSO-only accounts)', async () => {
    await expect(passwords.verify(null, '')).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it.each([
    ['short', /at least 8/],
    ['x'.repeat(129), /at most 128/],
    ['ada@example.org', /not be your email/],
    ['aaaaaaaaaaaa', /less repetitive/],
  ])('refuses %j', (password, reason) => {
    expect(passwords.weakness(password, 'Ada@Example.org')).toMatch(reason);
  });

  it('accepts a reasonable password', () => {
    expect(
      passwords.weakness('correct horse battery', 'ada@example.org'),
    ).toBeNull();
  });
});
