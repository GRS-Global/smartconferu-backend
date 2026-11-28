import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable error codes. The frontend switches on these, never on messages, so
 * a code is never renamed once released; add new ones instead.
 */
export const ErrorCode = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_EMAIL_NOT_VERIFIED: 'AUTH_EMAIL_NOT_VERIFIED',
  AUTH_ACCOUNT_LOCKED: 'AUTH_ACCOUNT_LOCKED',
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',
  AUTH_SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',
  AUTH_INVALID_LINK: 'AUTH_INVALID_LINK',
  AUTH_INVALID_CODE: 'AUTH_INVALID_CODE',
  AUTH_WEAK_PASSWORD: 'AUTH_WEAK_PASSWORD',
  AUTH_MFA_REQUIRED: 'AUTH_MFA_REQUIRED',
  AUTH_STEP_UP_REQUIRED: 'AUTH_STEP_UP_REQUIRED',
  CONFERENCE_SUSPENDED: 'CONFERENCE_SUSPENDED',
  SUPPORT_VIEW_READ_ONLY: 'SUPPORT_VIEW_READ_ONLY',
  AUTH_MFA_SETUP_REQUIRED: 'AUTH_MFA_SETUP_REQUIRED',
  AUTH_EMAIL_IN_USE: 'AUTH_EMAIL_IN_USE',
  AUTH_PROVIDER_NOT_CONFIGURED: 'AUTH_PROVIDER_NOT_CONFIGURED',
  AUTH_LAST_SIGN_IN_METHOD: 'AUTH_LAST_SIGN_IN_METHOD',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CONFLICT: 'CONFLICT',
  /** Another paper in the conference already has this title (submit, or change a title). */
  DUPLICATE_TITLE: 'DUPLICATE_TITLE',
  /** A chair (or the creator) tried to submit their own paper to the conference they run. */
  OWN_CONFERENCE: 'OWN_CONFERENCE',
  BUSINESS_RULE: 'BUSINESS_RULE',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_READY: 'NOT_READY',
  /** An AI provider failed or declined; the message says what to do. */
  AI_FAILED: 'AI_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Every error response the API sends has this shape. */
export interface ErrorBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Throw this for any expected failure; the message is shown to the user as written. */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static notFound(what: string): AppException {
    return new AppException(
      HttpStatus.NOT_FOUND,
      ErrorCode.NOT_FOUND,
      `${what} was not found.`,
    );
  }

  static forbidden(
    message = 'You do not have permission to do this.',
  ): AppException {
    return new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
  }

  /** The request is valid but the current state doesn't allow it (422), e.g. archiving a draft. */
  static businessRule(message: string): AppException {
    return new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.BUSINESS_RULE,
      message,
    );
  }

  static conflict(message: string): AppException {
    return new AppException(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);
  }

  static validation(message: string, details?: unknown): AppException {
    return new AppException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_FAILED,
      message,
      details,
    );
  }
}
