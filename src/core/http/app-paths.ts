/**
 * The web app's addresses that emails and notifications link to. Every page of a role inside a conference is
 * /<role>/<conference>/…: e.g. /chair/ictis2027/submissions/ICTIS-1. (The app still opens the older
 * /submissions/<paper>/chair|author, /conference/<c>/chair and /cfp-manager/<c>, for links sent before.)
 */
const e = encodeURIComponent;

export const appPaths = {
  /** The chair's page of a paper; `view` "review" is its peer review. */
  chairPaper: (conference: string, paper: string, view?: 'review') =>
    `/chair/${e(conference)}/submissions/${e(paper)}${view ? `/${view}` : ''}`,
  authorPaper: (conference: string, paper: string) =>
    `/author/${e(conference)}/submissions/${e(paper)}`,
  chairDashboard: (conference: string) => `/chair/${e(conference)}/dashboard`,
  cfpManager: (conference: string) => `/chair/${e(conference)}/cfp`,
} as const;
