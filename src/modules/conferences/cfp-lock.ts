/**
 * While a Call for Papers waits for the Super Admin (`in_review`), what it shows must stay as it was
 * sent: these conference fields, the abstract deadline (in `details`) and the logo. Everything
 * else about the conference stays editable.
 */
export const CFP_SHOWN_FIELDS = [
  'title',
  'about',
  'webPage',
  'venue',
  'city',
  'state',
  'country',
  'mode',
  'startDate',
  'endDate',
  'submissionDeadline',
] as const;

export const CFP_LOCKED_MESSAGE =
  "Your Call for Papers is waiting for the Super Admin's approval, so what it shows (name, dates, venue, website, description, deadlines and logo) can't be changed until it is decided.";

/** Equal for this purpose: dates by time, empty text and null alike. */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v instanceof Date ? v.getTime() : v === '' || v === undefined ? null : v;
  return norm(a) === norm(b);
}
