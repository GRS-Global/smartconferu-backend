import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../database/database.types.js';
import { emailLog, notifications, users } from '../database/schema/index.js';

/** Sent emails to this user's sign-in address (Notifications › Emails), as a condition on email_log. */
export const emailsTo = (userEmail: string) =>
  and(
    sql`lower(${emailLog.toEmail}) = lower(${userEmail})`,
    eq(emailLog.status, 'sent'),
  );

/** Unread notifications only (no emails): the Super Admin console, whose list has no Emails tab. */
export async function countUnreadNotifications(
  db: Executor,
  userId: string,
): Promise<number> {
  const [n] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return n?.count ?? 0;
}

/**
 * The bell's number: unread notifications plus unread emails sent to the user's address. The bell,
 * the Notifications page and the live-events stream all use this, so they always agree.
 */
export async function countUnread(
  db: Executor,
  userId: string,
): Promise<number> {
  const n = { count: await countUnreadNotifications(db, userId) };
  const [me] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!me?.email) {
    return n?.count ?? 0;
  }
  const [e] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailLog)
    .where(and(emailsTo(me.email), isNull(emailLog.recipientReadAt)));
  return (n?.count ?? 0) + (e?.count ?? 0);
}
