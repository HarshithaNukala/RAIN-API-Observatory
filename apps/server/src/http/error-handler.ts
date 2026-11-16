import type { ApiErrorBody } from '@rain/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
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
    req.log.error({ err: appError.cause ?? err }, appError.message);
  }
  if (appError.status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer');
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
