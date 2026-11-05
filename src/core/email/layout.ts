import type { EmailMessage } from './email.transport.js';

export interface EmailContent {
  to: string;
  subject: string;
  heading: string;
  /** Plain-text paragraphs; escaped for HTML. */
  paragraphs: string[];
  button?: { label: string; url: string };
  /** A one-time code, shown large. */
  code?: string;
  /** Small print under the button or code. */
  footnote?: string;
}

const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** The Smartconferu email layout, as HTML and plain text. */
export function renderEmail(content: EmailContent): EmailMessage {
  const paragraphs = content.paragraphs
    .map((p) => `<p>${escape(p)}</p>`)
    .join('');
  const button = content.button
    ? `<p style="margin:22px 0"><a href="${escape(content.button.url)}" style="display:inline-block;background:#7C3AED;color:#FFFFFF;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${escape(content.button.label)}</a></p>` +
      `<p style="color:#64748B;font-size:13px">Or copy this link into your browser:<br><a href="${escape(content.button.url)}" style="color:#4F46E5;word-break:break-all">${escape(content.button.url)}</a></p>`
    : '';
  const code = content.code
    ? `<p style="margin:22px 0;font-size:28px;font-weight:bold;letter-spacing:6px;color:#1E1B4B">${escape(content.code)}</p>`
    : '';
  const footnote = content.footnote
    ? `<p style="color:#64748B;font-size:13px">${escape(content.footnote)}</p>`
    : '';

  const html =
    '<!doctype html><html><body style="margin:0;padding:24px;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;color:#0F172A">' +
    '<div style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;padding:28px;font-size:15px;line-height:1.6">' +
    `<p style="margin:0 0 18px;font-size:18px;font-weight:bold;color:#1E1B4B">${escape(content.heading)}</p>` +
    paragraphs +
    button +
    code +
    footnote +
    '<p style="margin:24px 0 0;color:#64748B;font-size:13px">— The Smartconferu team</p>' +
    '</div>' +
    '<p style="max-width:600px;margin:12px auto 0;text-align:center;color:#94A3B8;font-size:12px">Smartconferu · Conference Management System</p>' +
    '</body></html>';

  const text = [
    content.heading,
    ...content.paragraphs,
    content.button ? `${content.button.label}: ${content.button.url}` : '',
    content.code ? `Your code: ${content.code}` : '',
    content.footnote ?? '',
    '— The Smartconferu team',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { to: content.to, subject: content.subject, html, text };
}
