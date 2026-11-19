import { emailLogoUrl, frameEmail } from './email-render.js';

describe('emailLogoUrl', () => {
  it('uses the app logo on a public address', () => {
    expect(emailLogoUrl('https://app.smartconferu.com')).toBe(
      'https://app.smartconferu.com/smartconferu-lockup.png',
    );
    expect(emailLogoUrl('https://app.smartconferu.com/')).toBe(
      'https://app.smartconferu.com/smartconferu-lockup.png',
    );
  });

  it('writes the name out where a mail client cannot reach the app', () => {
    for (const url of [
      'http://localhost:3100',
      'http://127.0.0.1:3100',
      'http://192.168.1.20:3100',
      'http://10.0.0.5',
      'http://172.20.1.1',
      'http://my-laptop.local:3100',
      'not a url',
    ]) {
      expect(emailLogoUrl(url)).toBeUndefined();
    }
  });

  it('lets a configured URL win, even on localhost', () => {
    expect(
      emailLogoUrl('http://localhost:3100', 'https://cdn.example.com/logo.png'),
    ).toBe('https://cdn.example.com/logo.png');
  });

  it('frames the email with the name when there is no logo', () => {
    const html = frameEmail('<p>Hi</p>', { title: 'Hello' });
    expect(html).not.toContain('<img');
    expect(html).toContain('Smartconferu</div>');
  });
});
