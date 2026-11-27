import * as rules from './access-rules.js';
import type { ConferenceAccess, SubmissionAccess } from './access-rules.js';

const conference = (
  over: Partial<ConferenceAccess> = {},
): ConferenceAccess => ({
  conferenceId: 'c1',
  status: 'active',
  isCreator: false,
  isSuperAdmin: false,
  activeRoles: [],
  isTeamMember: false,
  isAuthor: false,
  ...over,
});

const chair = (over: Partial<ConferenceAccess> = {}) =>
  conference({ activeRoles: ['chair'], isTeamMember: true, ...over });
const reviewerMember = conference({
  activeRoles: ['reviewer'],
  isTeamMember: true,
});
const superAdmin = conference({ isSuperAdmin: true });
const outsider = conference();

const paper = (over: Partial<SubmissionAccess> = {}): SubmissionAccess => ({
  submissionId: 's1',
  conference: outsider,
  reviewMode: 'double_blind',
  status: 'submitted',
  outcome: 'no_decision',
  notifiedOutcome: null,
  isSubmitter: false,
  isListedAuthor: false,
  isClaimed: true,
  assignmentStatus: null,
  ...over,
});

const submitter = (over: Partial<SubmissionAccess> = {}) =>
  paper({
    isSubmitter: true,
    conference: conference({ isAuthor: true }),
    ...over,
  });
const coAuthor = (over: Partial<SubmissionAccess> = {}) =>
  paper({
    isListedAuthor: true,
    conference: conference({ isAuthor: true }),
    ...over,
  });
const chairOnPaper = (over: Partial<SubmissionAccess> = {}) =>
  paper({ conference: chair(), ...over });
const reviewer = (
  status: SubmissionAccess['assignmentStatus'] = 'accepted',
  over: Partial<SubmissionAccess> = {},
) => paper({ conference: reviewerMember, assignmentStatus: status, ...over });

describe('access rules: conference', () => {
  it('counts chairs, track chairs and verified super admins as chairs', () => {
    expect(rules.isChair(chair())).toBe(true);
    expect(rules.isChair(conference({ activeRoles: ['track_chair'] }))).toBe(
      true,
    );
    expect(rules.isChair(superAdmin)).toBe(true);
    expect(rules.isChair(conference({ activeRoles: ['cfp_manager'] }))).toBe(
      false,
    );
    expect(rules.isChair(reviewerMember)).toBe(false);
  });

  it('shows the full conference to the creator, the team, super admins and its authors', () => {
    expect(
      rules.canViewConference(
        conference({ isCreator: true, status: 'pending_approval' }),
      ),
    ).toBe(true);
    expect(rules.canViewConference(conference({ isTeamMember: true }))).toBe(
      true,
    );
    expect(rules.canViewConference(superAdmin)).toBe(true);
    expect(rules.canViewConference(conference({ isAuthor: true }))).toBe(true);
    expect(
      rules.canViewConference(
        conference({ isAuthor: true, status: 'archived' }),
      ),
    ).toBe(true);
    expect(
      rules.canViewConference(
        conference({ isAuthor: true, status: 'rejected' }),
      ),
    ).toBe(false);
    expect(rules.canViewConference(outsider)).toBe(false);
  });

  it('shows a published or closed CFP to anyone, a draft only to the team', () => {
    expect(rules.canViewCfp(undefined, 'published')).toBe(true);
    expect(rules.canViewCfp(undefined, 'closed')).toBe(true);
    expect(rules.canViewCfp(undefined, 'draft')).toBe(false);
    expect(rules.canViewCfp(outsider, 'in_review')).toBe(false);
    expect(rules.canViewCfp(reviewerMember, 'draft')).toBe(true);
    expect(rules.canViewCfp(superAdmin, 'rejected')).toBe(true);
  });

  it('lets chairs and CFP managers edit the CFP', () => {
    expect(rules.canEditCfp(chair())).toBe(true);
    expect(rules.canEditCfp(conference({ activeRoles: ['cfp_manager'] }))).toBe(
      true,
    );
    expect(rules.canEditCfp(reviewerMember)).toBe(false);
  });

  it('shows the team to the team, manages it by chairs only', () => {
    expect(rules.canViewTeam(conference({ isTeamMember: true }))).toBe(true);
    expect(rules.canViewTeam(superAdmin)).toBe(true);
    expect(rules.canViewTeam(conference({ isAuthor: true }))).toBe(false);
    expect(rules.canManageTeam(chair())).toBe(true);
    expect(rules.canManageTeam(reviewerMember)).toBe(false);
  });

  it('shows tracks of an active conference to anyone', () => {
    expect(rules.canViewTracks(outsider)).toBe(true);
    expect(
      rules.canViewTracks(conference({ status: 'pending_approval' })),
    ).toBe(false);
    expect(
      rules.canViewTracks(
        conference({ status: 'pending_approval', isCreator: true }),
      ),
    ).toBe(true);
  });

  it('shows decision types to the team, super admins and authors', () => {
    expect(rules.canViewDecisionTypes(reviewerMember)).toBe(true);
    expect(rules.canViewDecisionTypes(conference({ isAuthor: true }))).toBe(
      true,
    );
    expect(rules.canViewDecisionTypes(superAdmin)).toBe(true);
    expect(rules.canViewDecisionTypes(outsider)).toBe(false);
  });

  it('keeps chair-only areas to chairs', () => {
    for (const rule of [
      rules.canManageConference,
      rules.canManageTracks,
      rules.canManageDecisionTypes,
      rules.canManageEmailTemplates,
      rules.canViewEmailLog,
      rules.canViewDeletionRequests,
      rules.canViewConferenceAiUsage,
    ]) {
      expect(rule(chair())).toBe(true);
      expect(rule(superAdmin)).toBe(true);
      expect(
        rule(conference({ activeRoles: ['cfp_manager'], isTeamMember: true })),
      ).toBe(false);
      expect(rule(reviewerMember)).toBe(false);
    }
  });

  describe('canSubmit', () => {
    const now = new Date('2027-03-01T12:00:00Z');
    const open = {
      cfpStatus: 'published' as const,
      submissionDeadline: new Date('2027-03-02T00:00:00Z'),
      now,
    };

    it('lets authors submit to an active conference with a published CFP before the deadline', () => {
      expect(rules.canSubmit(outsider, open)).toBe(true);
      expect(
        rules.canSubmit(outsider, { ...open, submissionDeadline: null }),
      ).toBe(true);
      expect(
        rules.canSubmit(outsider, { ...open, submissionDeadline: now }),
      ).toBe(true);
    });

    it('refuses authors after the deadline, or without a published CFP', () => {
      expect(
        rules.canSubmit(outsider, {
          ...open,
          submissionDeadline: new Date('2027-03-01T11:59:59Z'),
        }),
      ).toBe(false);
      expect(rules.canSubmit(outsider, { ...open, cfpStatus: 'draft' })).toBe(
        false,
      );
      expect(rules.canSubmit(outsider, { ...open, cfpStatus: 'closed' })).toBe(
        false,
      );
    });

    it('lets a chair submit on behalf of an author after the deadline, while the CFP is published', () => {
      const late = {
        cfpStatus: 'published' as const,
        submissionDeadline: new Date('2027-01-01'),
        now,
      };
      expect(rules.canSubmit(chair(), late)).toBe(true);
      expect(rules.canSubmit(superAdmin, late)).toBe(true);
      expect(rules.canSubmit(chair({ status: 'archived' }), late)).toBe(false);
    });

    it('refuses everyone, chairs included, when the CFP is not published', () => {
      for (const cfpStatus of [
        'draft',
        'in_review',
        'rejected',
        'closed',
      ] as const) {
        expect(rules.canSubmit(chair(), { ...open, cfpStatus })).toBe(false);
        expect(rules.canSubmit(superAdmin, { ...open, cfpStatus })).toBe(false);
      }
      expect(
        rules.canSubmit(conference({ status: 'pending_approval' }), open),
      ).toBe(false);
    });
  });

  it('assigns active reviewers now and invited ones when they accept', () => {
    expect(
      rules.reviewerAssignment({ role: 'reviewer', status: 'active' }),
    ).toBe('assign');
    expect(
      rules.reviewerAssignment({ role: 'reviewer', status: 'invited' }),
    ).toBe('pending');
    expect(
      rules.reviewerAssignment({ role: 'reviewer', status: 'declined' }),
    ).toBeNull();
    expect(
      rules.reviewerAssignment({ role: 'reviewer', status: 'removed' }),
    ).toBeNull();
    expect(
      rules.reviewerAssignment({ role: 'chair', status: 'active' }),
    ).toBeNull();
  });

  it('flags a reviewer from the same institution as an author (same email domain, webmail ignored)', () => {
    const authors = ['Ada@Uni.example.org', 'b@gmail.com'];
    const people = authors.map((email) => ({ email }));
    // No institution given by either: the email domain decides.
    expect(
      rules.institutionConflict({ email: 'rita@uni.example.org' }, people),
    ).toEqual({ by: 'email_domain', author: { email: 'Ada@Uni.example.org' } });
    expect(
      rules.institutionConflict({ email: 'rita@other.example.org' }, people),
    ).toBeNull();
    // Two people on gmail.com share nothing.
    expect(
      rules.institutionConflict({ email: 'rita@gmail.com' }, people),
    ).toBeNull();
    expect(rules.institutionConflict({ email: null }, people)).toBeNull();
    expect(
      rules.institutionConflict({ email: 'no-at-sign' }, people),
    ).toBeNull();
  });

  it('compares the institutions people gave before email domains', () => {
    const jatin = {
      name: 'Jatin Gohel',
      email: 'jatin@gr-conferences.com',
      affiliation: 'Navgujarat, Gujarat, India',
    };
    // Same company domain, different institutions: no conflict (the reported case).
    expect(
      rules.institutionConflict(
        { email: 'gaurav@gr-conferences.com', affiliation: 'ETH Zurich' },
        [jatin],
      ),
    ).toBeNull();
    // Same institution, written differently, different email domains: conflict.
    expect(
      rules.institutionConflict(
        { email: 'x@gmail.com', affiliation: '  the ETH-Zürich ' },
        [{ name: 'Ada', email: 'ada@ethz.ch', affiliation: 'ETH Zurich' }],
      ),
    ).toMatchObject({ by: 'institution', author: { name: 'Ada' } });
    expect(
      rules.institutionConflict({ affiliation: 'Science & Arts College' }, [
        { affiliation: 'Science and Arts College' },
      ]),
    ).toMatchObject({ by: 'institution' });
    // Typed with the place: the name before the first comma counts.
    expect(
      rules.institutionConflict({ affiliation: 'Delhi University' }, [
        { name: 'Shivam', affiliation: 'Delhi University, Delhi, India' },
      ]),
    ).toMatchObject({ by: 'institution', author: { name: 'Shivam' } });
    expect(
      rules.sameInstitution(
        'Delhi University, New Delhi, India',
        'Delhi University, Delhi, India',
      ),
    ).toBe(true);
    expect(
      rules.sameInstitution(
        'University of California, Berkeley',
        'University of California, Los Angeles',
      ),
    ).toBe(false);
    expect(
      rules.sameInstitution('ETH Zurich', 'Navgujarat, Gujarat, India'),
    ).toBe(false);
    // The reviewer gave no institution: the email domain still decides.
    expect(
      rules.institutionConflict({ email: 'gaurav@gr-conferences.com' }, [
        jatin,
      ]),
    ).toMatchObject({ by: 'email_domain', author: { name: 'Jatin Gohel' } });
    // The author gave none: same.
    expect(
      rules.institutionConflict(
        { email: 'gaurav@gr-conferences.com', affiliation: 'ETH Zurich' },
        [{ name: 'Jatin', email: 'jatin@gr-conferences.com', affiliation: '' }],
      ),
    ).toMatchObject({ by: 'email_domain' });
  });
});

describe('access rules: submission', () => {
  it('shows the paper to its authors, chairs and assigned reviewers', () => {
    expect(rules.canViewSubmission(submitter())).toBe(true);
    expect(rules.canViewSubmission(coAuthor())).toBe(true);
    expect(rules.canViewSubmission(chairOnPaper())).toBe(true);
    expect(rules.canViewSubmission(paper({ conference: superAdmin }))).toBe(
      true,
    );
    expect(rules.canViewSubmission(reviewer('assigned'))).toBe(true);
    expect(rules.canViewSubmission(reviewer('submitted'))).toBe(true);
    expect(rules.canViewSubmission(reviewer('declined'))).toBe(false);
    expect(rules.canViewSubmission(reviewer('removed'))).toBe(false);
    expect(rules.canViewSubmission(paper({ conference: reviewerMember }))).toBe(
      false,
    );
    expect(
      rules.canViewSubmission(
        paper({ conference: conference({ activeRoles: ['cfp_manager'] }) }),
      ),
    ).toBe(false);
  });

  it('hides the authors from reviewers under double-blind review only', () => {
    expect(rules.canSeeAuthors(reviewer('accepted'))).toBe(false);
    expect(
      rules.canSeeAuthors(reviewer('accepted', { reviewMode: 'single_blind' })),
    ).toBe(true);
    expect(
      rules.canSeeAuthors(reviewer('accepted', { reviewMode: 'open' })),
    ).toBe(true);
    expect(rules.canSeeAuthors(chairOnPaper())).toBe(true);
    expect(rules.canSeeAuthors(coAuthor())).toBe(true);
  });

  it('lets authors and chairs upload files until the paper is withdrawn', () => {
    expect(rules.canUploadFile(coAuthor({ outcome: 'accept' }))).toBe(true);
    expect(rules.canUploadFile(chairOnPaper())).toBe(true);
    expect(rules.canUploadFile(reviewer())).toBe(false);
    expect(rules.canUploadFile(submitter({ status: 'withdrawn' }))).toBe(false);
  });

  describe('editing details and authors', () => {
    it('allows linked authors and the submitter until there is a decision', () => {
      expect(rules.canEditDetails(coAuthor())).toBe(true);
      expect(rules.canEditDetails(submitter({ outcome: 'revise' }))).toBe(true);
      expect(rules.canEditDetails(submitter({ outcome: 'accept' }))).toBe(
        false,
      );
      expect(
        rules.canEditDetails(submitter({ outcome: 'plagiarism_clear' })),
      ).toBe(false);
      expect(rules.canEditDetails(submitter({ status: 'withdrawn' }))).toBe(
        false,
      );
      expect(rules.canEditAuthors(submitter())).toBe(true);
      expect(rules.canEditAuthors(coAuthor())).toBe(false);
    });

    it('lets a chair edit a paper only until an author claims it', () => {
      expect(rules.canEditDetails(chairOnPaper({ isClaimed: false }))).toBe(
        true,
      );
      expect(rules.canEditDetails(chairOnPaper({ isClaimed: true }))).toBe(
        false,
      );
      expect(rules.canEditAuthors(chairOnPaper({ isClaimed: false }))).toBe(
        true,
      );
      expect(rules.canEditAuthors(chairOnPaper({ isClaimed: true }))).toBe(
        false,
      );
    });

    it('stops a chair who submitted for an author once the author claims it', () => {
      const chairSubmitter = (isClaimed: boolean) =>
        paper({ conference: chair(), isSubmitter: true, isClaimed });
      expect(rules.canEditDetails(chairSubmitter(false))).toBe(true);
      expect(rules.canEditDetails(chairSubmitter(true))).toBe(false);
      // The submitter still manages the author list (submission_authors: submitter manages).
      expect(rules.canEditAuthors(chairSubmitter(true))).toBe(true);
    });

    it('never lets reviewers or outsiders edit', () => {
      expect(rules.canEditDetails(reviewer())).toBe(false);
      expect(rules.canEditDetails(paper({ isClaimed: false }))).toBe(false);
      expect(rules.canEditAuthors(paper({ isClaimed: false }))).toBe(false);
    });
  });

  describe('canWithdraw', () => {
    it('lets authors and chairs withdraw once', () => {
      expect(rules.canWithdraw(submitter())).toBe(true);
      expect(rules.canWithdraw(coAuthor())).toBe(true);
      expect(rules.canWithdraw(chairOnPaper())).toBe(true);
      expect(rules.canWithdraw(submitter({ status: 'withdrawn' }))).toBe(false);
      expect(rules.canWithdraw(reviewer())).toBe(false);
    });

    it('stops an author once a rejection was sent, a chair once it was recorded', () => {
      expect(rules.canWithdraw(coAuthor({ outcome: 'reject' }))).toBe(true);
      expect(
        rules.canWithdraw(
          coAuthor({ outcome: 'reject', notifiedOutcome: 'reject' }),
        ),
      ).toBe(false);
      expect(rules.canWithdraw(chairOnPaper({ outcome: 'reject' }))).toBe(
        false,
      );
      expect(
        rules.canWithdraw(
          coAuthor({ outcome: 'accept', notifiedOutcome: 'accept' }),
        ),
      ).toBe(true);
    });
  });

  it('shows decisions to authors and chairs; only chairs decide and manage reviews', () => {
    expect(rules.canViewDecisions(coAuthor())).toBe(true);
    expect(rules.canViewDecisions(reviewer())).toBe(false);
    expect(rules.canDecide(chairOnPaper())).toBe(true);
    expect(rules.canDecide(coAuthor())).toBe(false);
    expect(rules.canManageReviews(paper({ conference: superAdmin }))).toBe(
      true,
    );
    expect(rules.canManageReviews(reviewer())).toBe(false);
  });

  describe('reviews', () => {
    it('lets a reviewer write while the assignment is open', () => {
      expect(rules.canWriteReview(reviewer('assigned'))).toBe(true);
      expect(rules.canWriteReview(reviewer('accepted'))).toBe(true);
      expect(rules.canWriteReview(reviewer('submitted'))).toBe(false);
      expect(rules.canWriteReview(reviewer('declined'))).toBe(false);
      expect(
        rules.canWriteReview(reviewer('accepted', { status: 'withdrawn' })),
      ).toBe(false);
      expect(rules.canWriteReview(chairOnPaper())).toBe(false);
    });

    it('lets a reviewer correct a review until the paper has a decision', () => {
      expect(rules.canEditOwnReview(reviewer('submitted'))).toBe(true);
      expect(
        rules.canEditOwnReview(
          reviewer('submitted', { outcome: 'plagiarism_clear' }),
        ),
      ).toBe(true);
      expect(
        rules.canEditOwnReview(reviewer('submitted', { outcome: 'revise' })),
      ).toBe(false);
      expect(
        rules.canEditOwnReview(reviewer('submitted', { outcome: 'accept' })),
      ).toBe(false);
      expect(rules.canEditOwnReview(paper())).toBe(false);
    });

    it('lets a chair correct a sent review unless the paper is withdrawn', () => {
      expect(rules.canChairEditReview(chairOnPaper(), 'submitted')).toBe(true);
      expect(rules.canChairEditReview(chairOnPaper(), 'draft')).toBe(false);
      expect(
        rules.canChairEditReview(
          chairOnPaper({ status: 'withdrawn' }),
          'submitted',
        ),
      ).toBe(false);
      expect(rules.canChairEditReview(reviewer(), 'submitted')).toBe(false);
    });

    it('lets a chair review a submitted paper themselves', () => {
      expect(rules.canReviewAsChair(chairOnPaper())).toBe(true);
      expect(rules.canReviewAsChair(chairOnPaper({ status: 'draft' }))).toBe(
        false,
      );
      expect(
        rules.canReviewAsChair(chairOnPaper({ status: 'withdrawn' })),
      ).toBe(false);
      expect(rules.canReviewAsChair(reviewer())).toBe(false);
    });
  });

  it('opens the paper AI to chairs and assigned reviewers', () => {
    expect(rules.canUsePaperAi(chairOnPaper())).toBe(true);
    expect(rules.canUsePaperAi(reviewer('assigned'))).toBe(true);
    expect(rules.canUsePaperAi(coAuthor())).toBe(false);
  });
});
