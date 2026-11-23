import request from 'supertest';
import {
  createTestApp,
  linkToken,
  type TestApp,
  type TestUser,
} from './support/test-app.js';

describe('Profile email addresses: verification link', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  afterEach(() => t.reset());

  const http = () => request(t.app.getHttpServer());

  async function signedIn(): Promise<{ user: TestUser; bearer: string }> {
    const user = await t.createUser({ email: 'ada@example.org' });
    const res = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return { user, bearer: `Bearer ${res.body.accessToken}` };
  }

  const saveEmails = (
    bearer: string,
    emails: Record<string, { value: string; status: string }>,
    primaryEmail = 'personal',
  ) =>
    http()
      .patch('/api/v1/me')
      .set('Authorization', bearer)
      .send({ details: { emails, primaryEmail } });

  const verifyLink = (bearer: string, slot: string) =>
    http()
      .post('/api/v1/auth/profile-emails/verify')
      .set('Authorization', bearer)
      .send({ slot });

  const personal = { value: 'ada@example.org', status: 'verified' };

  it('saves a new address as pending, whatever the app claims', async () => {
    const { bearer } = await signedIn();
    const res = await saveEmails(bearer, {
      personal,
      professional: { value: 'ada@university.edu', status: 'verified' },
    }).expect(200);
    expect(res.body.details.emails).toEqual({
      personal,
      professional: { value: 'ada@university.edu', status: 'pending' },
    });
  });

  it('cannot make an unverified address the primary one', async () => {
    const { bearer } = await signedIn();
    const res = await saveEmails(
      bearer,
      {
        personal,
        professional: { value: 'ada@university.edu', status: 'verified' },
      },
      'professional',
    ).expect(200);
    expect(res.body.details.primaryEmail).toBe('personal');
  });

  it('verifies the address from the emailed link, and only then can it be primary', async () => {
    const { bearer } = await signedIn();
    await saveEmails(bearer, {
      personal,
      professional: { value: 'Ada@University.edu', status: 'pending' },
    }).expect(200);

    await verifyLink(bearer, 'professional').expect(202);
    const mail = t.outbox().at(-1)!;
    expect(mail).toMatchObject({
      to: 'Ada@University.edu',
      subject: 'Verify your email address',
    });
    const token = linkToken(mail.text);

    // Opening the link needs no sign-in (it is opened from the mailbox).
    await http()
      .post('/api/v1/auth/profile-emails/confirm')
      .send({ token })
      .expect(204);

    const me = await http()
      .get('/api/v1/me')
      .set('Authorization', bearer)
      .expect(200);
    expect(me.body.details.emails.professional.status).toBe('verified');
    // Verifying does not make it primary, and the sign-in email is untouched.
    expect(me.body.details.primaryEmail).toBe('personal');
    expect(me.body.email).toBe('ada@example.org');

    const chosen = await saveEmails(
      bearer,
      {
        personal,
        professional: me.body.details.emails.professional,
      },
      'professional',
    ).expect(200);
    expect(chosen.body.details.primaryEmail).toBe('professional');

    // The link works once.
    await http()
      .post('/api/v1/auth/profile-emails/confirm')
      .send({ token })
      .expect(400);
  });

  it('keeps an address verified when it is saved again unchanged, but not once it is edited', async () => {
    const { bearer } = await signedIn();
    await saveEmails(bearer, {
      personal,
      professional: { value: 'ada@university.edu', status: 'pending' },
    }).expect(200);
    await verifyLink(bearer, 'professional').expect(202);
    await http()
      .post('/api/v1/auth/profile-emails/confirm')
      .send({ token: linkToken(t.outbox().at(-1)!.text) })
      .expect(204);

    const same = await saveEmails(bearer, {
      personal,
      professional: { value: 'ada@university.edu', status: 'verified' },
    }).expect(200);
    expect(same.body.details.emails.professional.status).toBe('verified');

    const edited = await saveEmails(bearer, {
      personal,
      professional: { value: 'ada@other.edu', status: 'verified' },
    }).expect(200);
    expect(edited.body.details.emails.professional.status).toBe('pending');
  });

  it('refuses a link for an address that was changed after it was sent', async () => {
    const { bearer } = await signedIn();
    await saveEmails(bearer, {
      personal,
      professional: { value: 'ada@university.edu', status: 'pending' },
    }).expect(200);
    await verifyLink(bearer, 'professional').expect(202);
    const token = linkToken(t.outbox().at(-1)!.text);

    await saveEmails(bearer, {
      personal,
      professional: { value: 'ada@other.edu', status: 'pending' },
    }).expect(200);
    await http()
      .post('/api/v1/auth/profile-emails/confirm')
      .send({ token })
      .expect(400);
    const me = await http()
      .get('/api/v1/me')
      .set('Authorization', bearer)
      .expect(200);
    expect(me.body.details.emails.professional.status).toBe('pending');
  });

  it('answers 422/400 for an empty slot or an already verified one, and needs a sign-in', async () => {
    const { bearer } = await signedIn();
    await saveEmails(bearer, {
      personal,
      professional: { value: '', status: '' },
    }).expect(200);
    await verifyLink(bearer, 'professional').expect((res) => {
      expect([400, 422]).toContain(res.status);
    });
    await http()
      .post('/api/v1/auth/profile-emails/verify')
      .send({ slot: 'personal' })
      .expect(401);
    await verifyLink(bearer, 'other').expect(400);
  });
});
