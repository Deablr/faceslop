// The error model shared by server and client.
//
// Server code fails with `AppError` in the Effect error channel. The server-function bridge
// (src/server/bridge.ts) lets AppError cross to the client unchanged; any other failure or defect
// is logged on the server and reaches the client as AppError INTERNAL with a generic message.
// The client recognizes it with `appErrorOf` / `toClientError`.
//
// AppError survives Start's serializer because `appErrorSerializationAdapter` is registered in
// src/start.ts (Start's default error serializer would keep only `message`).
import { createSerializationAdapter } from '@tanstack/react-router';
import { Predicate, Schema } from 'effect';

export const ApiErrorCode = Schema.Literals([
  'BAD_REQUEST',
  'NOT_FOUND',
  /** Action requires a Facebook login (e.g. messaging). */
  'NOT_LOGGED_IN',
  /** Facebook redirected to a login wall / checkpoint / rate limit. */
  'FB_BLOCKED',
  /** Facebook's page loaded but we couldn't find the data we expected. */
  'FB_PARSE_FAILED',
  'FB_TIMEOUT',
  /** Search session expired; re-run the search. */
  'SESSION_EXPIRED',
  'FORBIDDEN',
  /** APP_PASSWORD is set and this browser hasn't entered it; show the app password screen. */
  'APP_LOCKED',
  'INTERNAL',
]);
export type ApiErrorCode = typeof ApiErrorCode.Type;

/** The one typed failure every service and server function uses. */
export class AppError extends Schema.TaggedError<AppError>()('AppError', {
  code: ApiErrorCode,
  message: Schema.String,
}) {}

/** HTTP status for an error code (server routes such as /api/remote/stream answer with these). */
export const httpStatusOf: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  NOT_LOGGED_IN: 401,
  FB_BLOCKED: 502,
  FB_PARSE_FAILED: 502,
  FB_TIMEOUT: 504,
  SESSION_EXPIRED: 410,
  FORBIDDEN: 403,
  APP_LOCKED: 401,
  INTERNAL: 500,
};

/** JSON error body for plain HTTP server routes (server functions throw AppError instead). */
export const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({ code: ApiErrorCode, message: Schema.String }),
});
export type ApiErrorBody = typeof ApiErrorBody.Type;

export const INTERNAL_MESSAGE = 'Something went wrong on the faceslop server.';

// ---------- client-side recognition ----------

export interface AppErrorInfo {
  readonly code: ApiErrorCode;
  readonly message: string;
}

const isApiErrorCode = Schema.is(ApiErrorCode);

/**
 * The code and message of an AppError, from any thrown value (e.g. a rejected server function
 * call or a TanStack Query `error`). Returns null for anything that isn't an AppError.
 */
export function appErrorOf(error: unknown): AppErrorInfo | null {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  // Structural fallback: a second copy of this module (HMR, duplicated chunk) has its own class.
  if (
    Predicate.isObject(error) &&
    Predicate.hasProperty(error, '_tag') &&
    error._tag === 'AppError' &&
    Predicate.hasProperty(error, 'code') &&
    isApiErrorCode(error.code) &&
    Predicate.hasProperty(error, 'message') &&
    Predicate.isString(error.message)
  ) {
    return { code: error.code, message: error.message };
  }
  return null;
}

/** Server error codes, plus NETWORK when the faceslop server can't be reached at all. */
export type ClientErrorCode = ApiErrorCode | 'NETWORK';

export interface ClientErrorInfo {
  readonly code: ClientErrorCode;
  readonly message: string;
}

/** Like appErrorOf, but always returns something displayable. */
export function toClientError(error: unknown): ClientErrorInfo {
  const appError = appErrorOf(error);
  if (appError) return appError;
  // fetch() rejects with a TypeError when the server is unreachable.
  if (error instanceof TypeError) {
    return { code: 'NETWORK', message: "Can't reach the faceslop server. Is it running?" };
  }
  return { code: 'INTERNAL', message: INTERNAL_MESSAGE };
}

// ---------- serialization across the server-function boundary ----------

/**
 * Registered in src/start.ts (`serializationAdapters`). Start runs adapters before its default
 * error plugin, so AppError keeps its code on the way to the client (and in SSR dehydration).
 */
export const appErrorSerializationAdapter = createSerializationAdapter({
  key: 'faceslop/AppError',
  test: (value): value is AppError => value instanceof AppError,
  toSerializable: (error) => ({ code: error.code, message: error.message }),
  fromSerializable: (value: { code: string; message: string }) =>
    new AppError({ code: isApiErrorCode(value.code) ? value.code : 'INTERNAL', message: value.message }),
});
