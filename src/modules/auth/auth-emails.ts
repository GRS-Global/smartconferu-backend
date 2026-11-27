import type { EmailMessage } from '../../core/email/email.transport.js';
import { renderEmail } from '../../core/email/layout.js';

export const VERIFY_EMAIL_TTL_MINUTES = 24 * 60;
export const RESET_PASSWORD_TTL_MINUTES = 60;
export const LOGIN_CODE_TTL_MINUTES = 10;
export const CHANGE_EMAIL_TTL_MINUTES = 24 * 60;
export const MERGE_CODE_TTL_MINUTES = 10;
export const VERIFY_PROFILE_EMAIL_TTL_MINUTES = 24 * 60;

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  orcid: 'ORCID',
};

export const confirmEmailChange = (to: string, url: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Confirm your new email address',
    heading: 'Confirm your new email address',
    paragraphs: [
      `You asked to use ${to} for your Smartconferu account. Confirm it to finish the change.`,
    ],
    button: { label: 'Confirm this address', url },
    footnote:
      "The link works once and expires after 24 hours. If you didn't ask for this, you can ignore this email.",
  });

export const verifyProfileEmail = (to: string, url: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Verify your email address',
    heading: 'Verify your email address',
    paragraphs: [
      `You added ${to} to your Smartconferu profile. Verify it to confirm the address is yours.`,
      'Your sign-in email does not change. Once verified, you can choose this address as your primary one for notifications.',
    ],
    button: { label: 'Verify this address', url },
    footnote:
      "The link works once and expires after 24 hours. If you didn't add this address, you can ignore this email.",
  });

export const emailChangeRequested = (
  to: string,
  newEmail: string,
): EmailMessage =>
  renderEmail({
    to,
    subject: 'Your email address is being changed',
    heading: 'Your email address is being changed',
    paragraphs: [
      `Someone signed in to your account asked to change its email address to ${newEmail}. Nothing changes until that address is confirmed.`,
      "If this wasn't you, change your password straight away.",
    ],
  });

export const emailChanged = (to: string, newEmail: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Your email address was changed',
    heading: 'Your email address was changed',
    paragraphs: [
      `Your Smartconferu account now uses ${newEmail}. This address will no longer receive account emails.`,
      "If this wasn't you, contact the conference team straight away.",
    ],
  });

export const mergeCode = (to: string, code: string): EmailMessage =>
  renderEmail({
    to,
    subject: `Connect your sign-in to your Smartconferu account: ${code}`,
    heading: 'Connect a new sign-in to your account',
    paragraphs: [
      `Someone is connecting a new sign-in method to the account for ${to}. Enter this code to confirm it's you:`,
    ],
    code,
    footnote:
      "The code expires after 10 minutes. If you didn't ask for this, you can ignore this email.",
  });

export const mfaTurnedOn = (to: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Two-step verification is on',
    heading: 'Two-step verification is on',
    paragraphs: [
      'Signing in to your Smartconferu account now also needs a code from your authenticator app.',
      'Keep your recovery codes somewhere safe: they get you in if you lose your phone.',
    ],
  });

export const mfaTurnedOff = (to: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Two-step verification was turned off',
    heading: 'Two-step verification was turned off',
    paragraphs: [
      'Signing in to your Smartconferu account no longer needs a code from your authenticator app.',
      "If this wasn't you, change your password and turn it back on straight away.",
    ],
  });

export const identityLinked = (to: string, provider: string): EmailMessage =>
  renderEmail({
    to,
    subject: `${PROVIDER_NAMES[provider] ?? provider} sign-in added to your account`,
    heading: `You can now sign in with ${PROVIDER_NAMES[provider] ?? provider}`,
    paragraphs: [
      `A ${PROVIDER_NAMES[provider] ?? provider} account was connected to your Smartconferu account.`,
      "If this wasn't you, remove it in your account settings and change your password.",
    ],
  });

export const verifyEmail = (to: string, url: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Confirm your email address',
    heading: 'Confirm your email address',
    paragraphs: [
      `Welcome to Smartconferu. Please confirm that ${to} is your email address to finish creating your account.`,
    ],
    button: { label: 'Confirm my email', url },
    footnote:
      "The link works once and expires after 24 hours. If you didn't create an account, you can ignore this email.",
  });

export const accountAlreadyExists = (
  to: string,
  signInUrl: string,
  resetUrl: string,
): EmailMessage =>
  renderEmail({
    to,
    subject: 'You already have a Smartconferu account',
    heading: 'You already have an account',
    paragraphs: [
      `Someone, probably you, tried to create a new account with ${to}. That address already has an account, so nothing was changed.`,
      `Sign in at ${signInUrl}. If you've forgotten your password, you can reset it at ${resetUrl}.`,
    ],
    footnote: "If this wasn't you, you can ignore this email.",
  });

/** Someone signed in elsewhere asked to use this address for their own account; it already belongs to this one, so nothing changed. */
export const emailChangeToExisting = (
  to: string,
  signInUrl: string,
  resetUrl: string,
): EmailMessage =>
  renderEmail({
    to,
    subject: 'Someone tried to use your email address',
    heading: 'Someone tried to use your email address',
    paragraphs: [
      `A Smartconferu member asked to change their sign-in email to ${to}. That address already belongs to your account, so nothing was changed.`,
      `If it was you, sign in at ${signInUrl}. If you've forgotten your password, you can reset it at ${resetUrl}.`,
    ],
    footnote: "If you don't know why you received this, you can ignore it.",
  });

export const resetPassword = (to: string, url: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Reset your password',
    heading: 'Reset your password',
    paragraphs: [`We received a request to reset the password for ${to}.`],
    button: { label: 'Choose a new password', url },
    footnote:
      "The link works once and expires after an hour. If you didn't ask for this, you can ignore this email — your password stays the same.",
  });

/** The admin console's own reset email: the link opens the console's reset page, not the website's. */
export const adminResetPassword = (to: string, url: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Reset your Super Admin console password',
    heading: 'Reset your admin console password',
    paragraphs: [
      `We received a request from the Super Admin console to reset the password for ${to}.`,
    ],
    button: { label: 'Choose a new password', url },
    footnote:
      "The link works once and expires after an hour. If you didn't ask for this, you can ignore this email — your password stays the same.",
  });

export const loginCode = (to: string, code: string): EmailMessage =>
  renderEmail({
    to,
    subject: `Your Smartconferu sign-in code: ${code}`,
    heading: 'Your sign-in code',
    paragraphs: ['Enter this code to sign in to Smartconferu:'],
    code,
    footnote:
      "The code works once and expires after 10 minutes. If you didn't ask for it, you can ignore this email.",
  });

export const adminSignInCode = (to: string, code: string): EmailMessage =>
  renderEmail({
    to,
    subject: `Your Smartconferu admin sign-in code: ${code}`,
    heading: 'Your admin sign-in code',
    paragraphs: [
      'Someone signed in to the Smartconferu admin console with your password. Enter this code to finish signing in:',
    ],
    code,
    footnote:
      "The code works once and expires after 10 minutes. If this wasn't you, change your password straight away.",
  });

export const passwordChanged = (to: string): EmailMessage =>
  renderEmail({
    to,
    subject: 'Your password was changed',
    heading: 'Your password was changed',
    paragraphs: [
      `The password for ${to} was just changed, and you were signed out on your other devices.`,
      "If you didn't do this, reset your password straight away and contact the conference team.",
    ],
  });
