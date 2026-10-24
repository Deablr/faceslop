import { describe, expect, it } from 'vitest';
import { AppError, appErrorOf, httpStatusOf, toClientError } from '@/shared/errors';
import { decodeResponse } from './helpers/client-serialization';
import { createDefaultSerovalPlugins, makeSerovalPlugin } from '@tanstack/router-core/ssr/client';
import { toCrossJSONAsync } from 'seroval';
import { appErrorSerializationAdapter } from '@/shared/errors';

describe('appErrorOf', () => {
  it('recognizes AppError instances', () => {
    expect(appErrorOf(new AppError({ code: 'NOT_FOUND', message: 'gone' }))).toEqual({ code: 'NOT_FOUND', message: 'gone' });
  });

  it('recognizes structurally identical errors from another module copy', () => {
    expect(appErrorOf({ _tag: 'AppError', code: 'FB_BLOCKED', message: 'wall' })).toEqual({
      code: 'FB_BLOCKED',
      message: 'wall',
    });
  });

  it('rejects everything else', () => {
    expect(appErrorOf(new Error('x'))).toBeNull();
    expect(appErrorOf({ _tag: 'AppError', code: 'NOPE', message: 'x' })).toBeNull();
    expect(appErrorOf(null)).toBeNull();
    expect(appErrorOf('AppError')).toBeNull();
  });
});

describe('toClientError', () => {
  it('maps fetch failures to NETWORK and unknown errors to INTERNAL', () => {
    expect(toClientError(new TypeError('Failed to fetch')).code).toBe('NETWORK');
    expect(toClientError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'Something went wrong on the faceslop server.' });
    expect(toClientError(new AppError({ code: 'APP_LOCKED', message: 'locked' })).code).toBe('APP_LOCKED');
  });
});

describe('httpStatusOf', () => {
  it('matches legacy statuses', () => {
    expect(httpStatusOf.SESSION_EXPIRED).toBe(410);
    expect(httpStatusOf.FB_TIMEOUT).toBe(504);
    expect(httpStatusOf.APP_LOCKED).toBe(401);
  });
});

describe('appErrorSerializationAdapter', () => {
  it('carries code and message through Seroval like a server-function error response', async () => {
    // What Start's server does for a failed call: { error } serialized with adapters first.
    const plugins = [makeSerovalPlugin(appErrorSerializationAdapter), ...createDefaultSerovalPlugins()];
    const wire = JSON.parse(
      JSON.stringify(await toCrossJSONAsync({ error: new AppError({ code: 'SESSION_EXPIRED', message: 'Search again.' }) }, { refs: new Map(), plugins })),
    ) as unknown;
    const decoded = decodeResponse(wire) as { error: unknown };
    expect(decoded.error).toBeInstanceOf(AppError);
    expect(appErrorOf(decoded.error)).toEqual({ code: 'SESSION_EXPIRED', message: 'Search again.' });
  });
});
