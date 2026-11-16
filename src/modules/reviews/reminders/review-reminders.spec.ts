import {
  offsetMinutes,
  planReviewReminders,
  REVIEW_TIMELINE_DEFAULTS,
  timelineOf,
} from './review-reminders.js';

const base = {
  id: 'a1',
  reviewerId: 'r1',
  submissionId: 's1',
  assignedAt: new Date('2027-03-01T10:00:00Z'),
};

describe('review reminders', () => {
  it('reads a timezone offset', () => {
    expect(offsetMinutes('Thailand | GMT +07:00')).toBe(420);
    expect(offsetMinutes('GMT -05:30')).toBe(-330);
    expect(offsetMinutes(undefined)).toBe(0);
  });

  it('fills a saved timeline over the defaults', () => {
    expect(timelineOf({ reminder1Days: '5', reminder2Enabled: false })).toEqual(
      {
        ...REVIEW_TIMELINE_DEFAULTS,
        reminder1Days: 5,
        reminder2Enabled: false,
        closesAt: null,
      },
    );
  });

  it('plans reminder 1 three days before a chosen deadline and reminder 2 on the day', () => {
    const due = new Date('2027-03-20T23:59:59Z');
    const plan = (now: string) =>
      planReviewReminders({
        now: new Date(now),
        offsetMin: 0,
        timeline: timelineOf({}),
        assignments: [{ ...base, dueAt: due }],
      });
    expect(plan('2027-03-17T08:00:00Z')).toEqual([
      expect.objectContaining({ kind: 1, daysLeft: 3, dueDay: '2027-03-20' }),
    ]);
    expect(plan('2027-03-18T08:00:00Z')).toEqual([]);
    expect(plan('2027-03-20T08:00:00Z')).toEqual([
      expect.objectContaining({ kind: 2, daysLeft: 0 }),
    ]);
  });

  it('uses the assignment day + review days, capped at the end of the review period', () => {
    const plan = planReviewReminders({
      now: new Date('2027-03-10T08:00:00Z'),
      offsetMin: 0,
      timeline: timelineOf({ closesAt: '2027-03-13' }),
      assignments: [{ ...base, dueAt: null }],
    });
    expect(plan).toEqual([
      expect.objectContaining({ dueDay: '2027-03-13', daysLeft: 3, kind: 1 }),
    ]);
  });

  it("counts days in the conference's own timezone", () => {
    // 20:00 UTC on the 16th is already the 17th in GMT+07:00: three days before the 20th.
    const plan = planReviewReminders({
      now: new Date('2027-03-16T20:00:00Z'),
      offsetMin: 420,
      timeline: timelineOf({}),
      assignments: [{ ...base, dueAt: new Date('2027-03-20T23:59:59Z') }],
    });
    expect(plan).toHaveLength(1);
  });
});
