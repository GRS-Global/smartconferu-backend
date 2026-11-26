import {
  parseAmount,
  parseAttendance,
  parseCategory,
  parseDate,
  parseMethod,
  parsePaperNo,
  parsePayment,
  paymentProblems,
  receiptType,
  type PaymentValues,
} from './payment.js';

const today = '2026-11-26';
const none: PaymentValues = {
  payment: 'not_paid',
  amount: null,
  method: null,
  paidOn: null,
  transactionRef: null,
  payerName: null,
};
const paid = (over: Partial<PaymentValues> = {}): PaymentValues => ({
  ...none,
  payment: 'paid',
  amount: 250,
  ...over,
});
const fields = (values: PaymentValues, currency: string | null = 'INR') =>
  Object.fromEntries(
    paymentProblems(values, currency, today).map((p) => [p.field, p.errors]),
  );

describe('paymentProblems', () => {
  it('accepts a full paid fee, and an unpaid or waived one without details', () => {
    expect(
      fields(
        paid({
          method: 'bank_transfer',
          paidOn: '2026-11-20',
          transactionRef: 'TX-1',
          payerName: 'Ada',
        }),
      ),
    ).toEqual({});
    expect(fields(none)).toEqual({});
    expect(fields({ ...none, payment: 'waived' }, null)).toEqual({});
  });

  it('needs an amount and a conference currency for a paid fee', () => {
    expect(fields(paid({ amount: null }))).toEqual({
      amount: ['Enter the amount paid.'],
    });
    expect(fields(paid(), null).amount?.[0]).toMatch(
      /Set the conference currency/,
    );
  });

  it('refuses a zero, negative, too large or over-precise amount', () => {
    expect(fields(paid({ amount: 0 })).amount).toBeDefined();
    expect(fields(paid({ amount: -5 })).amount).toBeDefined();
    expect(fields(paid({ amount: 1_000_000_000 })).amount).toEqual([
      'The amount is too large.',
    ]);
    expect(fields(paid({ amount: 10.005 })).amount).toEqual([
      'Use at most 2 decimals.',
    ]);
    expect(fields(paid({ amount: 0.1 + 0.2 }))).toEqual({}); // float noise is fine
  });

  it('keeps the details for a paid fee only', () => {
    const problems = fields({
      ...none,
      amount: 10,
      method: 'cash',
      paidOn: '2026-11-01',
      transactionRef: 'x',
      payerName: 'y',
    });
    expect(Object.keys(problems).sort()).toEqual(
      ['amount', 'method', 'paidOn', 'payerName', 'transactionRef'].sort(),
    );
  });

  it('refuses a payment date in the future (one day of slack) or before 2000', () => {
    expect(fields(paid({ paidOn: '2026-11-27' }))).toEqual({});
    expect(fields(paid({ paidOn: '2026-11-28' })).paidOn).toEqual([
      'The payment date can’t be in the future.',
    ]);
    expect(fields(paid({ paidOn: '1999-12-31' })).paidOn).toBeDefined();
    expect(fields(paid({ paidOn: '2026-02-30' })).paidOn).toEqual([
      'Use a real date (YYYY-MM-DD).',
    ]);
  });
});

describe('reading an import', () => {
  it('knows the everyday words for each value, whatever the case or spacing', () => {
    expect(parsePayment('Not paid')).toBe('not_paid');
    expect(parsePayment('NOT-PAID')).toBe('not_paid');
    expect(parsePayment(' paid ')).toBe('paid');
    expect(parsePayment('Free')).toBe('waived');
    expect(parsePayment('half')).toBeUndefined();
    expect(parseMethod('UPI')).toBe('online');
    expect(parseMethod('Bank Transfer')).toBe('bank_transfer');
    expect(parseMethod('NEFT')).toBe('bank_transfer');
    expect(parseMethod('cheque')).toBeUndefined();
    expect(parseAttendance('Digital')).toBe('virtual');
    expect(parseAttendance('In person')).toBe('physical');
    expect(parseCategory('Co-author')).toBe('co_author');
    expect(parseCategory('Student Participant')).toBe('student');
  });

  it('reads amounts with a currency or thousands separators, never guessing', () => {
    expect(parseAmount('250')).toBe(250);
    expect(parseAmount('1,250.50')).toBe(1250.5);
    expect(parseAmount('₹ 1,25,000')).toBe(125000);
    expect(parseAmount('Rs. 2,500')).toBe(2500);
    expect(parseAmount('USD 99')).toBe(99);
    expect(parseAmount('1,250,000')).toBe(1250000);
    // Could be read two ways, or isn't a number.
    expect(parseAmount('1,50')).toBeNull();
    expect(parseAmount('1.250,00')).toBeNull();
    expect(parseAmount('1.2.3')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('reads dates as YYYY-MM-DD or day first', () => {
    expect(parseDate('2026-11-05')).toBe('2026-11-05');
    expect(parseDate('2026-1-5')).toBe('2026-01-05');
    expect(parseDate('05/11/2026')).toBe('2026-11-05');
    expect(parseDate('5.11.2026')).toBe('2026-11-05');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('11/05/26')).toBeNull();
  });

  it("reads a paper id with or without the conference's own prefix", () => {
    expect(parsePaperNo('APME-12', 'APME')).toBe(12);
    expect(parsePaperNo('apme 12', 'APME')).toBe(12);
    expect(parsePaperNo('#12', 'APME')).toBe(12);
    expect(parsePaperNo('12', 'APME')).toBe(12);
    expect(parsePaperNo('ICX-12', 'APME')).toBeNull();
    expect(parsePaperNo('0', 'APME')).toBeNull();
  });
});

describe('receiptType', () => {
  it('goes by the first bytes as well as the name', () => {
    expect(receiptType('r.pdf', Buffer.from('%PDF-1.7 ...'))).toEqual({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    expect(
      receiptType('r.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])),
    ).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(receiptType('r.pdf', Buffer.from('<html>'))).toBeNull();
    expect(receiptType('r.exe', Buffer.from('%PDF-1.7'))).toBeNull();
  });
});
