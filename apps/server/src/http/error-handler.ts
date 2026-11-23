import type { ApiErrorBody, ApiFieldIssue } from '@rain/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import { isQueryError, safeError } from '../safe-error.js';

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

function issueCode(issue: ZodError['issues'][number]): string | undefined {
  const code = (issue as { params?: { code?: unknown } }).params?.code;
  return typeof code === 'string' ? code : undefined;
}

function validationError(err: ZodError): AppError {
  const details: ApiFieldIssue[] = err.issues.map((i) => {
    const code = issueCode(i);
    return { path: i.path.join('.'), message: i.message, ...(code && { code }) };
  });
  // A request whose only problem is an unsupported port gets that as its top-level code too;
  // with several problems the response stays a general VALIDATION_ERROR.
  const [only] = details;
  if (details.length === 1 && only?.code === 'UNSUPPORTED_PORT') {
    return new AppError(400, only.code, only.message, details);
  }
  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return validationError(err);
  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (err.status >= 400 && err.status < 500) {
      return new AppError(400, 'VALIDATION_ERROR', 'Malformed request body');
    }
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error', undefined, { cause: err });
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const appError = toAppError(err);
  if (appError.status >= 500) {
    const cause = appError.cause ?? err;
    // Database errors carry the SQL and its parameter values in their message: log only the
    // driver's code and message. Other errors keep their stack for debugging.
    req.log.error(
      isQueryError(cause) ? { error: safeError(cause) } : { err: cause },
      appError.message,
    );
  }
  if (appError.status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  const retryAfter = (appError.details as { retryAfterSeconds?: unknown } | undefined)
    ?.retryAfterSeconds;
  if (appError.code === 'CHECK_COOLDOWN' && typeof retryAfter === 'number') {
    res.setHeader('Retry-After', String(retryAfter));
  }
  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId: String(req.id),
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };
  res.status(appError.status).json(body);
};
