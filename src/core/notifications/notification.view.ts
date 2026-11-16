import type { notifications } from '../database/schema/index.js';

/** A notification as the bell and the live-event stream show it. */
export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  conferenceId: string | null;
  submissionId: string | null;
  readAt: string | null;
  createdAt: string;
}

export function toNotificationView(
  n: typeof notifications.$inferSelect,
): NotificationView {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    conferenceId: n.conferenceId,
    submissionId: n.submissionId,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}
