import {
  assertPublicUrl,
  pageToText,
  textLiterals,
  unscrambleEmail,
} from './website-reader.js';

describe('website reader', () => {
  it('turns a page into text with its emails listed first', () => {
    const text = pageToText(`<html><head><title>ICX 2027</title>
      <meta name="description" content="The X conference"></head>
      <body><h1>ICX 2027</h1><p>Paper queries: <a href="mailto:papers@icx.org">write to us</a></p>
      <p>Help: info [at] icx [dot] org</p><script>var x = 1;</script></body></html>`);
    expect(text).toContain('Page title: ICX 2027');
    expect(text).toContain('description: The X conference');
    expect(text).toMatch(
      /Emails on this page:\n- papers@icx\.org \(preceded by: "….*Paper queries: write to us \("\)/,
    );
    expect(text).toContain('info@icx.org');
    expect(text).not.toContain('var x');
  });

  it('decodes Cloudflare-protected and ROT13-scrambled addresses', () => {
    // "a@b.co" XOR 0x11
    const hex =
      '11' +
      'a@b.co'
        .split('')
        .map((c) => (c.charCodeAt(0) ^ 0x11).toString(16).padStart(2, '0'))
        .join('');
    expect(
      pageToText(`<span data-cfemail="${hex}">[email protected]</span>`),
    ).toContain('a@b.co');
    expect(unscrambleEmail('zvep2026@fpvraprfpbas.bet')).toBe(
      'mirc2026@sciencesconf.org',
    );
    expect(unscrambleEmail('info@icx.org')).toBe('info@icx.org');
  });

  it('keeps readable text out of a script bundle', () => {
    const text = textLiterals(
      `const a={name:"Grand Hotel Goa",cls:"flex items-center px-4",fn:"() => 1",email:"hi@icx.org"};`,
    );
    expect(text.split('\n')).toEqual([
      'name: Grand Hotel Goa',
      'email: hi@icx.org',
    ]);
  });

  it('refuses private and non-web addresses', async () => {
    for (const url of [
      'http://localhost/',
      'http://10.0.0.5/',
      'ftp://icx.org/',
      'http://[::1]/',
      'http://user:pw@icx.org/',
    ]) {
      await expect(assertPublicUrl(new URL(url))).rejects.toThrow();
    }
  });
});
