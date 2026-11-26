/**
 * The two emails a Super Admin's decision on a conference request sends. Their text lives in the
 * platform's `email_templates` (the Super Admin edits it in the decision popup or in Email
 * Templates); these are only the fallback when a row is missing. Platform-only: a conference never
 * gets its own copy of them.
 */
export const DECISION_TEMPLATE_KEYS = [
  'conferenceApproved',
  'conferenceDeclined',
] as const;

export type DecisionTemplateKey = (typeof DECISION_TEMPLATE_KEYS)[number];

export const DECISION_FALLBACKS: Record<
  DecisionTemplateKey,
  { label: string; subject: string; body: string }
> = {
  conferenceApproved: {
    label: 'Conference approved',
    subject: '{{conference_acronym}} is approved',
    body: '<p>Dear {{first_name}},</p><p>Your request to host {{conference_acronym}} ({{conference_name}}) on Smartconferu has been approved. Open your conference to add the call for papers, tracks, deadlines and reviewers:</p><p>{{dashboard_link}}</p>',
  },
  conferenceDeclined: {
    label: 'Conference request declined',
    subject: 'Your request for {{conference_acronym}}',
    body: "<p>Dear {{first_name}},</p><p>Thank you for your interest in hosting {{conference_acronym}} on Smartconferu. We weren't able to approve the request:</p><p>“{{reason}}”</p><p>You can send a new request any time from My Conferences.</p>",
  },
};
