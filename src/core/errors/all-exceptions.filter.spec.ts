import {
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { toErrorBody } from './all-exceptions.filter.js';
import { AppException, ErrorCode } from './app.exception.js';

const pgError = (code: string, message = 'boom') =>
  Object.assign(new Error(message), { code, severity: 'ERROR' });
/** Drizzle wraps driver errors: the SQLSTATE sits on `cause`. */
const wrapped = (inner: Error) =>
  Object.assign(new Error('Failed query'), { cause: inner });

describe('toErrorBody', () => {
  it('keeps an AppException as thrown', () => {
    const body = toErrorBody(
      AppException.validation('Bad input.', [{ field: 'x', errors: ['y'] }]),
    );
    expect(body).toEqual({
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Bad input.',
      details: [{ field: 'x', errors: ['y'] }],
    });
  });

  it.each([
    [new NotFoundException('Cannot GET /nope'), 404, ErrorCode.NOT_FOUND],
    [new ThrottlerException(), 429, ErrorCode.RATE_LIMITED],
    [new ServiceUnavailableException(), 500, ErrorCode.INTERNAL_ERROR],
  ])('maps %s to a stable code', (exception, status, code) => {
    expect(toErrorBody(exception)).toMatchObject({ statusCode: status, code });
  });

  it('does not echo framework messages such as route paths', () => {
    expect(
      toErrorBody(new NotFoundException('Cannot GET /secret')).message,
    ).toBe('Not found.');
  });

  it('passes the message of a SQL `raise exception` through as a business rule', () => {
    const body = toErrorBody(
      wrapped(pgError('P0001', 'The submission deadline has passed.')),
    );
    expect(body).toEqual({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ErrorCode.BUSINESS_RULE,
      message: 'The submission deadline has passed.',
    });
  });

  it.each([
    ['42501', 403, ErrorCode.FORBIDDEN],
    ['23505', 409, ErrorCode.CONFLICT],
    ['23503', 409, ErrorCode.CONFLICT],
    ['22P02', 400, ErrorCode.VALIDATION_FAILED],
    ['23514', 400, ErrorCode.VALIDATION_FAILED],
  ])('maps SQLSTATE %s to %i', (sqlstate, status, code) => {
    expect(toErrorBody(wrapped(pgError(sqlstate)))).toMatchObject({
      statusCode: status,
      code,
    });
  });

  it('answers 503 when the database cannot be reached', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    for (const error of [
      refused,
      new Error('Failed query', { cause: refused }),
      Object.assign(new Error('write CONNECT_TIMEOUT'), {
        code: 'CONNECT_TIMEOUT',
      }),
    ]) {
      expect(toErrorBody(error)).toEqual({
        statusCode: 503,
        code: ErrorCode.NOT_READY,
        message: 'The service is temporarily unavailable. Please try again.',
      });
    }
  });

  it('hides unexpected database and runtime errors behind a generic 500', () => {
    for (const error of [
      wrapped(pgError('XX000', 'internal detail')),
      new TypeError('x is undefined'),
      'a string',
    ]) {
      expect(toErrorBody(error)).toEqual({
        statusCode: 500,
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Something went wrong. Please try again.',
      });
    }
  });
});
