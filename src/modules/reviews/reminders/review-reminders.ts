/**
 * The two automatic review reminders (Peer Review › Review timeline), ported from the app's
 * src/shared/reviewReminders.js:
 *   Reminder 1: `reminder1Days` days before a reviewer's deadline ("N days left"), template reviewDueSoon
 *   Reminder 2: `reminder2Days` days before it (0 = the last day),                 template reviewLastDay
 * A reviewer's deadline is the date the chair gave the assignment; without one it is the assignment
 * day + `reviewDays`, never past the end of the review period. "Today" is the conference's own day.
 */

export interface ReviewTimeline {
  reviewDays: number;
  reminder1Enabled: boolean;
  reminder1Days: number;
  reminder2Enabled: boolean;
  reminder2Days: number;
  /** The end of the review period (yyyy-mm-dd…), if set. */
  closesAt?: string | null;
}

export const REVIEW_TIMELINE_DEFAULTS: ReviewTimeline = {
  reviewDays: 14,
  reminder1Enabled: true,
  reminder1Days: 3,
  reminder2Enabled: true,
  reminder2Days: 0,
};

export interface WaitingAssignment {
  id: string;
  reviewerId: string;
  submissionId: string;
  assignedAt: Date;
  dueAt: Date | null;
}

export interface PlannedReminder extends WaitingAssignment {
  dueDay: string;
  daysLeft: number;
  kind: 1 | 2;
}

const DAY = 86_400_000;

/** "Thailand | GMT +07:00" → 420; anything else → 0 (UTC). */
export function offsetMinutes(timezone: unknown): number {
  const m = /([+-])(\d{1,2}):(\d{2})/.exec(
    typeof timezone === 'string' ? timezone : '',
  );
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** The calendar day (yyyy-mm-dd) of `date` for someone `offsetMin` minutes ahead of UTC. */
const dayOf = (date: Date, offsetMin: number) =>
  new Date(date.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** The conference's saved timeline over the defaults (unknown fields ignored). */
export function timelineOf(saved: unknown): ReviewTimeline {
  const s =
    typeof saved === 'object' && saved !== null
      ? (saved as Record<string, unknown>)
      : {};
  const num = (key: keyof ReviewTimeline) =>
    typeof s[key] === 'number' || (typeof s[key] === 'string' && s[key] !== '')
      ? Number(s[key])
      : (REVIEW_TIMELINE_DEFAULTS[key] as number);
  const flag = (key: keyof ReviewTimeline) =>
    typeof s[key] === 'boolean'
      ? s[key]
      : (REVIEW_TIMELINE_DEFAULTS[key] as boolean);
  return {
    reviewDays: num('reviewDays'),
    reminder1Enabled: flag('reminder1Enabled'),
    reminder1Days: num('reminder1Days'),
    reminder2Enabled: flag('reminder2Enabled'),
    reminder2Days: num('reminder2Days'),
    closesAt: typeof s.closesAt === 'string' ? s.closesAt : null,
  };
}

/** The reminders due today for assignments still waiting for a review. */
export function planReviewReminders({
  now,
  offsetMin,
  timeline,
  assignments,
}: {
  now: Date;
  offsetMin: number;
  timeline: ReviewTimeline;
  assignments: readonly WaitingAssignment[];
}): PlannedReminder[] {
  const today = dayOf(now, offsetMin);
  const periodEnd = (timeline.closesAt ?? '').slice(0, 10);
  const plan: PlannedReminder[] = [];
  for (const a of assignments) {
    let dueDay: string;
    if (a.dueAt) {
      // The app saves a chosen date as that day at 23:59:59 UTC: keep the day the chair picked.
      dueDay =
        a.dueAt.getUTCHours() === 23 && a.dueAt.getUTCMinutes() === 59
          ? a.dueAt.toISOString().slice(0, 10)
          : dayOf(a.dueAt, offsetMin);
    } else {
      dueDay = dayOf(
        new Date(a.assignedAt.getTime() + timeline.reviewDays * DAY),
        offsetMin,
      );
      if (periodEnd && dueDay > periodEnd) {
        dueDay = periodEnd;
      }
    }
    const daysLeft = daysBetween(today, dueDay);
    const r1 = timeline.reminder1Enabled && daysLeft === timeline.reminder1Days;
    const r2 = timeline.reminder2Enabled && daysLeft === timeline.reminder2Days;
    if (r1 || r2) {
      plan.push({ ...a, dueDay, daysLeft, kind: r2 ? 2 : 1 });
    }
  }
  return plan;
}

export const daysLabel = (n: number) =>
  n <= 0 ? 'today' : n === 1 ? '1 day' : `${n} days`;
