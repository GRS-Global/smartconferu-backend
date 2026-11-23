/**
 * The personal / professional addresses under My Profile › Email addresses live inside the private
 * profile JSON (`details.emails`, `details.primaryEmail`). The app writes that JSON, so the server
 * decides what "verified" means: only an address that was already verified and is unchanged, or the
 * account's own verified sign-in address. Everything else is saved as "pending" until its emailed
 * link is opened.
 */

export const EMAIL_SLOTS = ['personal', 'professional'] as const;
export type EmailSlot = (typeof EMAIL_SLOTS)[number];

interface Slot {
  value: string;
  status: string;
}

export const isEmailSlot = (value: unknown): value is EmailSlot =>
  value === 'personal' || value === 'professional';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** One stored slot, read defensively. */
export function readSlot(emails: unknown, slot: EmailSlot): Slot {
  const raw = record(record(emails)[slot]);
  return {
    value: typeof raw.value === 'string' ? raw.value.trim() : '',
    status: typeof raw.status === 'string' ? raw.status : '',
  };
}

export interface GuardedDetails {
  details: Record<string, unknown>;
  /** Slots whose address is new and unverified: each needs a verification link. */
  needsLink: EmailSlot[];
}

/**
 * Returns `details` with the email slots made trustworthy. `previous` is what is stored now.
 * `account` is the sign-in address and whether it is verified.
 */
export function guardProfileEmails(
  details: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  account: { email: string | null; verified: boolean },
): GuardedDetails {
  if (!('emails' in details) && !('primaryEmail' in details)) {
    return { details, needsLink: [] };
  }
  const before = record(previous);
  const sent =
    'emails' in details ? record(details.emails) : record(before.emails);
  const next: Record<EmailSlot, Slot> = {
    personal: { value: '', status: '' },
    professional: { value: '', status: '' },
  };
  const needsLink: EmailSlot[] = [];
  for (const slot of EMAIL_SLOTS) {
    const value = readSlot(sent, slot).value;
    const old = readSlot(before.emails, slot);
    if (!value) continue;
    const verified =
      (old.status === 'verified' && same(old.value, value)) ||
      (account.verified &&
        account.email !== null &&
        same(account.email, value));
    next[slot] = { value, status: verified ? 'verified' : 'pending' };
    if (!verified && !(old.status === 'pending' && same(old.value, value))) {
      needsLink.push(slot);
    }
  }

  // The primary address has to be a verified one; otherwise keep what it was, then any verified one.
  const wanted = details.primaryEmail;
  const usable = (slot: unknown): slot is EmailSlot =>
    isEmailSlot(slot) && next[slot].status === 'verified';
  const kept = before.primaryEmail;
  const primaryEmail = usable(wanted)
    ? wanted
    : usable(kept)
      ? kept
      : (EMAIL_SLOTS.find((slot) => next[slot].status === 'verified') ?? '');

  return { details: { ...details, emails: next, primaryEmail }, needsLink };
}
