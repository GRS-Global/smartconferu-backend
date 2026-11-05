import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException, type ErrorBody, ErrorCode } from './app.exception.js';

/** Turns every thrown error into the one ErrorBody shape, and logs the unexpected ones. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const body = toErrorBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(exception);
    }
    response.status(body.statusCode).json({
      ...body,
      requestId: typeof request.id === 'string' ? request.id : undefined,
    });
  }
}

export function toErrorBody(exception: unknown): ErrorBody {
  if (exception instanceof AppException) {
    return {
      statusCode: exception.getStatus(),
      code: exception.code,
      message: exception.message,
      details: exception.details,
    };
  }
  if (exception instanceof HttpException) {
    return fromHttpException(exception);
  }
  const pg = findPostgresError(exception);
  if (pg) {
    return fromPostgresError(pg);
  }
  if (isDatabaseUnreachable(exception)) {
    return {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: ErrorCode.NOT_READY,
      message: 'The service is temporarily unavailable. Please try again.',
    };
  }
  return internalError();
}

/** Network errors (Node) and postgres.js connection errors: the database can't be reached. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

function isDatabaseUnreachable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (
      typeof candidate.code === 'string' &&
      UNREACHABLE_CODES.has(candidate.code)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

const STATUS_CODES: Partial<Record<number, [ErrorCode, string]>> = {
  [HttpStatus.BAD_REQUEST]: [
    ErrorCode.VALIDATION_FAILED,
    'The request is not valid.',
  ],
  [HttpStatus.UNAUTHORIZED]: [ErrorCode.AUTH_REQUIRED, 'Sign in to continue.'],
  [HttpStatus.FORBIDDEN]: [
    ErrorCode.FORBIDDEN,
    'You do not have permission to do this.',
  ],
  [HttpStatus.NOT_FOUND]: [ErrorCode.NOT_FOUND, 'Not found.'],
  [HttpStatus.METHOD_NOT_ALLOWED]: [ErrorCode.NOT_FOUND, 'Not found.'],
  [HttpStatus.CONFLICT]: [
    ErrorCode.CONFLICT,
    'This conflicts with existing data.',
  ],
  [HttpStatus.PAYLOAD_TOO_LARGE]: [
    ErrorCode.VALIDATION_FAILED,
    'The request is too large.',
  ],
  [HttpStatus.TOO_MANY_REQUESTS]: [
    ErrorCode.RATE_LIMITED,
    'Too many requests. Please wait a moment and try again.',
  ],
};

function fromHttpException(exception: HttpException): ErrorBody {
  const statusCode = exception.getStatus();
  const known = STATUS_CODES[statusCode];
  if (!known) {
    return statusCode >= 500
      ? internalError()
      : {
          statusCode,
          code: ErrorCode.VALIDATION_FAILED,
          message: exception.message,
        };
  }
  return { statusCode, code: known[0], message: known[1] };
}

interface PostgresError {
  code: string;
  message: string;
  detail?: string;
}

/** postgres.js errors carry a 5-character SQLSTATE; Drizzle wraps them in `cause`. */
function findPostgresError(error: unknown): PostgresError | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const candidate = current as Partial<PostgresError> & { cause?: unknown };
    if (
      typeof candidate.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code) &&
      typeof candidate.message === 'string'
    ) {
      return candidate as PostgresError;
    }
    current = candidate.cause;
  }
  return undefined;
}

function fromPostgresError(error: PostgresError): ErrorBody {
  switch (error.code) {
    // `raise exception '...'` in our SQL functions: the message is written for users.
    case 'P0001':
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.BUSINESS_RULE,
        message: error.message,
      };
    // insufficient_privilege, including an RLS `with check` failure.
    case '42501':
      return {
        statusCode: HttpStatus.FORBIDDEN,
        code: ErrorCode.FORBIDDEN,
        message: 'You do not have permission to do this.',
      };
    case '23505':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'This already exists.',
      };
    case '23503':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message:
          'This refers to something that does not exist or is still in use.',
      };
    case '22P02':
    case '22007':
    case '22001':
    case '23502':
    case '23514':
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Some of the values are not valid.',
      };
    default:
      return internalError();
  }
}

function internalError(): ErrorBody {
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ErrorCode.INTERNAL_ERROR,
    message: 'Something went wrong. Please try again.',
  };
}
