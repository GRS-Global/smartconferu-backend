import {
  attendanceMode,
  participantCategory,
  paymentMethod,
  paymentStatus,
} from '../../core/database/schema/index.js';

/**
 * Registration fees as the chair records them, for accepted papers and for participants alike:
 * the rules a payment must follow, the words an import may use for each value, and the receipt
 * files that can be attached. Pure functions, unit tested in payment.spec.ts.
 */

export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type PaymentMethod = (typeof paymentMethod.enumValues)[number];
export type AttendanceMode = (typeof attendanceMode.enumValues)[number];
export type ParticipantCategory =
  (typeof participantCategory.enumValues)[number];

export const PAYMENT_METHODS = paymentMethod.enumValues;
export const PARTICIPANT_CATEGORIES = participantCategory.enumValues;

/** The largest amount accepted (the column holds 12 digits, 2 after the point). */
export const MAX_AMOUNT = 1_000_000_000;

export interface PaymentValues {
  payment: PaymentStatus;
  amount: number | null;
  method: PaymentMethod | null;
  /** YYYY-MM-DD. */
  paidOn: string | null;
  transactionRef: string | null;
  payerName: string | null;
}

export interface FieldProblem {
  field: string;
  errors: string[];
}

const DETAIL_FIELDS = [
  'amount',
  'method',
  'paidOn',
  'transactionRef',
  'payerName',
] as const;

/**
 * What is wrong with a payment, field by field (empty when it's fine):
 * - Paid needs an amount, and the conference needs a currency for it.
 * - The details (amount, method, date, transaction ID, payer) belong to a paid fee only.
 * - The payment date can't be in the future (one day of slack for time zones) or before 2000.
 */
export function paymentProblems(
  values: PaymentValues,
  currency: string | null,
  today: string,
): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const add = (field: string, error: string) => {
    const known = problems.find((p) => p.field === field);
    if (known) known.errors.push(error);
    else problems.push({ field, errors: [error] });
  };
  if (values.payment === 'paid') {
    if (values.amount === null) {
      add('amount', 'Enter the amount paid.');
    } else if (!currency) {
      add(
        'amount',
        'Set the conference currency (conference details) before recording amounts.',
      );
    }
  } else {
    for (const field of DETAIL_FIELDS) {
      if (values[field] !== null) {
        add(
          field,
          'Payment details can be filled in only when the fee is Paid.',
        );
      }
    }
  }
  if (values.amount !== null) {
    if (!Number.isFinite(values.amount) || values.amount <= 0) {
      add('amount', 'The amount must be more than 0.');
    } else if (values.amount >= MAX_AMOUNT) {
      add('amount', 'The amount is too large.');
    } else if (
      Math.abs(Math.round(values.amount * 100) - values.amount * 100) > 1e-6
    ) {
      add('amount', 'Use at most 2 decimals.');
    }
  }
  if (values.paidOn !== null) {
    if (!isDate(values.paidOn)) {
      add('paidOn', 'Use a real date (YYYY-MM-DD).');
    } else if (values.paidOn > addDays(today, 1)) {
      add('paidOn', 'The payment date can’t be in the future.');
    } else if (values.paidOn < '2000-01-01') {
      add('paidOn', 'The payment date is too far in the past.');
    }
  }
  return problems;
}

/** A calendar date written YYYY-MM-DD that exists (no 31 February). */
export function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

// Reading an import ---------------------------------------------------------------------------

/** "Not paid", "not_paid", "NOT-PAID" → "not paid": how cells are compared. */
const words = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');

const PAYMENT_WORDS: Record<string, PaymentStatus> = {
  paid: 'paid',
  'not paid': 'not_paid',
  unpaid: 'not_paid',
  pending: 'not_paid',
  waived: 'waived',
  free: 'waived',
};
const METHOD_WORDS: Record<string, PaymentMethod> = {
  'bank transfer': 'bank_transfer',
  bank: 'bank_transfer',
  'wire transfer': 'bank_transfer',
  neft: 'bank_transfer',
  rtgs: 'bank_transfer',
  online: 'online',
  'online payment': 'online',
  upi: 'online',
  paypal: 'online',
  card: 'card',
  'credit card': 'card',
  'debit card': 'card',
  cash: 'cash',
  other: 'other',
};
const ATTENDANCE_WORDS: Record<string, AttendanceMode> = {
  physical: 'physical',
  'in person': 'physical',
  offline: 'physical',
  virtual: 'virtual',
  digital: 'virtual',
  online: 'virtual',
};
const CATEGORY_WORDS: Record<string, ParticipantCategory> = {
  standard: 'standard',
  'standard participant': 'standard',
  delegate: 'standard',
  student: 'student',
  'student participant': 'student',
  'co author': 'co_author',
  coauthor: 'co_author',
  'co author participant': 'co_author',
  'coauthor participant': 'co_author',
};

const pick =
  <T>(table: Record<string, T>) =>
  (text: string): T | undefined =>
    table[words(text)];

export const parsePayment = pick(PAYMENT_WORDS);
export const parseMethod = pick(METHOD_WORDS);
export const parseAttendance = pick(ATTENDANCE_WORDS);
export const parseCategory = pick(CATEGORY_WORDS);

/**
 * "1,250.50", "₹ 1,25,000", "Rs. 1250", "USD 99" → 1250.5 / 125000 / 1250 / 99. Commas count
 * only as thousands separators (US or Indian grouping); anything else that could be read two
 * ways ("1,50", "1.250,00") is null, so a money value is never guessed.
 */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[^\d.,-]/g, '').replace(/^[.,]+/, '');
  const plain = /^-?\d+(\.\d+)?$/;
  const grouped = /^-?\d{1,3}(,\d{2,3})*,\d{3}(\.\d+)?$/;
  if (!plain.test(cleaned) && !grouped.test(cleaned)) return null;
  return Number(cleaned.replace(/,/g, ''));
}

/**
 * A payment date as typed in a sheet: YYYY-MM-DD, or day first (DD/MM/YYYY, DD-MM-YYYY,
 * DD.MM.YYYY), the way dates are written where our conferences are held. null when unreadable.
 */
export function parseDate(text: string): string | null {
  const value = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  const parts = iso
    ? [iso[1], iso[2], iso[3]]
    : dayFirst
      ? [dayFirst[3], dayFirst[2], dayFirst[1]]
      : null;
  if (!parts) return null;
  const date = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  return isDate(date) ? date : null;
}

/**
 * The paper number in a paper id as written in a sheet: "APME-12", "apme 12", "#12" or "12".
 * A prefix must be the conference's own (null otherwise, as for anything unreadable).
 */
export function parsePaperNo(text: string, prefix: string): number | null {
  let rest = text.trim().replace(/^#\s*/, '');
  if (rest.toUpperCase().startsWith(prefix.toUpperCase())) {
    rest = rest.slice(prefix.length).replace(/^[\s-]+/, '');
  }
  if (!/^\d{1,9}$/.test(rest)) return null;
  const no = Number(rest);
  return no > 0 ? no : null;
}

// Receipts -----------------------------------------------------------------------------------

/** Receipt files: PDF or an image, told apart by their first bytes, not only their name. */
const RECEIPT_TYPES = [
  {
    ext: ['.pdf'],
    mime: 'application/pdf',
    magic: (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  {
    ext: ['.jpg', '.jpeg'],
    mime: 'image/jpeg',
    magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: ['.png'],
    mime: 'image/png',
    magic: (b: Buffer) =>
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  {
    ext: ['.webp'],
    mime: 'image/webp',
    magic: (b: Buffer) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** The receipt's content type and extension, or null when it isn't a PDF, JPG, PNG or WebP. */
export function receiptType(
  fileName: string,
  data: Buffer,
): { mime: string; ext: string } | null {
  const ext = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0] ?? '';
  const type = RECEIPT_TYPES.find((t) => t.ext.includes(ext) && t.magic(data));
  return type ? { mime: type.mime, ext: type.ext[0].slice(1) } : null;
}

export function receiptContentType(fileName: string): string {
  const ext = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0] ?? '';
  return (
    RECEIPT_TYPES.find((t) => t.ext.includes(ext))?.mime ??
    'application/octet-stream'
  );
}
