import { paperStage } from './admin.service.js';

const today = '2027-03-10';
const a = (status: string, submitted = false, due: string | null = null) => ({
  status,
  submitted,
  dueAt: due ? new Date(`${due}T23:59:59Z`) : null,
});

describe('paperStage', () => {
  it('follows the paper through screening', () => {
    expect(paperStage('upload_pending', [], 2, today)).toBe('upload');
    expect(paperStage('no_decision', [], 2, today)).toBe('screening');
    expect(paperStage('accept', [a('submitted', true)], 2, today)).toBe(
      'decided',
    );
  });

  it('tells where review stands', () => {
    expect(paperStage('plagiarism_clear', [], 2, today)).toBe(
      'needs_reviewers',
    );
    expect(paperStage('plagiarism_clear', [a('assigned')], 2, today)).toBe(
      'awaiting_response',
    );
    expect(paperStage('plagiarism_clear', [a('accepted')], 2, today)).toBe(
      'in_review',
    );
    expect(
      paperStage(
        'plagiarism_clear',
        [a('accepted', false, '2027-03-09')],
        2,
        today,
      ),
    ).toBe('overdue');
    expect(
      paperStage(
        'plagiarism_clear',
        [a('submitted', true), a('submitted', true)],
        2,
        today,
      ),
    ).toBe('ready');
    // Only one reviewer assigned: their review is enough to decide.
    expect(
      paperStage('plagiarism_clear', [a('submitted', true)], 2, today),
    ).toBe('ready');
    expect(
      paperStage(
        'plagiarism_clear',
        [a('submitted', true), a('accepted')],
        2,
        today,
      ),
    ).toBe('in_review');
  });
});
