// The bridge: AppError mapping, input validation, and running Effects on the app runtime with the
// caller's CurrentClient (read from the request before the Effect runs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cause, Effect, Option } from 'effect';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readRequestInfo, runEffect, runEffectResponse, toAppError, validate } from '@/server/bridge';
import { disposeRuntime } from '@/server/runtime';
import { EMPTY_REQUEST_INFO, currentSession, ensureOwner } from '@/server/session/CurrentClient';
import { Sessions } from '@/server/session/Sessions';
import { AuthStatusRequest, HiddenListingInput, LoginRequest, SavedSearchInput, SearchParams, SettingsPatch } from '@/shared/domain';
import { AppError, INTERNAL_MESSAGE } from '@/shared/errors';
import { OpenRemoteViewRequest } from '@/shared/remote-view';

describe('toAppError', () => {
  it('passes an AppError failure through unchanged', () => {
    const error = new AppError({ code: 'NOT_FOUND', message: 'This listing is no longer available on Facebook.' });
    expect(toAppError(Cause.fail(error))).toBe(error);
  });

  it('maps defects and foreign failures to INTERNAL with a generic message, logging the cause', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const cause of [Cause.die(new Error('not implemented: X')), Cause.fail(new Error('raw')), Cause.interrupt()]) {
      const mapped = toAppError(cause);
      expect(mapped).toBeInstanceOf(AppError);
      expect(mapped.code).toBe('INTERNAL');
      expect(mapped.message).toBe(INTERNAL_MESSAGE);
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(String(log.mock.calls[0]?.[0])).toContain('not implemented: X');
    log.mockRestore();
  });
});

describe('readRequestInfo', () => {
  it("reads the session cookie, the proxy's headers and the protocol from a request", () => {
    const request = new Request('https://faceslop.example.com/_serverFn/x', {
      headers: {
        cookie: 'theme=dark; faceslop_session=abc_DEF-123; other=1',
        'x-forwarded-for': '198.51.100.9, 203.0.113.7',
        'x-forwarded-proto': 'https',
      },
    });
    expect(readRequestInfo(request)).toEqual({
      token: 'abc_DEF-123',
      remoteAddress: null, // no request event behind a hand-made Request
      forwardedFor: '198.51.100.9, 203.0.113.7',
      forwardedProto: 'https',
      protocol: 'https',
      method: 'GET',
    });
    expect(readRequestInfo(new Request('http://127.0.0.1:3000/')).token).toBeUndefined();
  });

  it('is empty outside a request', () => {
    expect(readRequestInfo()).toEqual(EMPTY_REQUEST_INFO);
  });
});

/** Feed deliberately mistyped input, as a malicious or stale client could. */
const parseUntyped = (input: unknown): unknown => (validate(SearchParams).parse as (raw: unknown) => unknown)(input);

describe('validate', () => {
  it('returns the decoded value', () => {
    expect(validate(SearchParams).parse({ query: ' bike ' })).toEqual({ query: 'bike' });
  });

  it('throws BAD_REQUEST listing each problem with its path', () => {
    try {
      parseUntyped({ radiusKm: 900, sortBy: 'nope' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const { code, message } = error as AppError;
      expect(code).toBe('BAD_REQUEST');
      expect(message).toContain('radiusKm:');
      expect(message).toContain('sortBy:');
    }
  });

  it('never echoes the rejected input (passwords)', () => {
    const secret = `hunter2-${'x'.repeat(1200)}`;
    try {
      validate(LoginRequest).parse({ email: 'me@example.com', password: secret });
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).message).not.toContain('hunter2');
    }
  });

  it('treats optional keys set to undefined as absent (TypeScript allows them; Seroval sends them)', () => {
    expect(validate(SearchParams).parse({ query: undefined, category: 'bicycles', conditions: undefined })).toEqual({
      category: 'bicycles',
    });
    expect(validate(AuthStatusRequest).parse({ verify: undefined })).toEqual({});
    expect(validate(SavedSearchInput).parse({ name: 'Bikes', params: { query: undefined }, autoCheck: undefined })).toEqual({
      name: 'Bikes',
      params: {},
      autoCheck: true,
    });
    expect(validate(HiddenListingInput).parse({ id: '123', title: undefined })).toEqual({ id: '123', title: '' });
    expect(validate(SettingsPatch).parse({ defaultRadiusKm: undefined, sessionNudgeMinutes: 10 })).toEqual({
      sessionNudgeMinutes: 10,
    });
    expect(validate(OpenRemoteViewRequest).parse({ target: 'inbox', listingId: undefined })).toEqual({ target: 'inbox' });
    // A required key is still required.
    expect(() => validate(OpenRemoteViewRequest).parse({ target: 'listing', listingId: undefined })).toThrow(AppError);
    expect(() => validate(LoginRequest).parse({ email: 'me@example.com', password: undefined as unknown as string })).toThrow(
      'password: Missing key',
    );
  });

  it('joins at most five issues as "path: message"', () => {
    try {
      parseUntyped({ radiusKm: 0, minPrice: -1, maxPrice: -1, sortBy: 1, delivery: 1, exact: 'yes', query: 5 });
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).message.split('; ')).toHaveLength(5);
    }
  });
});

describe('runEffect (app runtime)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-bridge-'));

  beforeAll(() => {
    process.env.FACESLOP_DATA_DIR = dataDir;
    process.env.FACESLOP_DISABLE_CHECKER = '1';
  });

  afterAll(async () => {
    await disposeRuntime();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves with the value, rejects with the AppError, and maps defects to INTERNAL', async () => {
    expect(await runEffect(Effect.succeed(42))).toBe(42);
    await expect(runEffect(Effect.fail(new AppError({ code: 'FORBIDDEN', message: 'Wrong password.' })))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Wrong password.',
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runEffect(Effect.die(new Error('boom: secret internals')))).rejects.toMatchObject({
      code: 'INTERNAL',
      message: INTERNAL_MESSAGE,
    });
    log.mockRestore();
    // The runtime built the real database layer in the configured data dir.
    expect(fs.existsSync(path.join(dataDir, 'faceslop.db'))).toBe(true);
  });

  it('provides CurrentClient: outside a request there is no session until the call creates one', async () => {
    const seen = await runEffect(
      Effect.gen(function* () {
        const before = yield* currentSession;
        // Creates a session; outside a request there is no cookie to set, and that is not an error.
        const owner = yield* ensureOwner;
        const after = yield* currentSession;
        return { before, owner, after: Option.getOrNull(after) };
      }),
    );
    expect(seen.before).toEqual(Option.none());
    expect(seen.after).not.toBeNull();
    expect(seen.owner).toBe(`session:${String(seen.after?.id)}`);
  });

  it("runEffectResponse reads the session from the given request's cookie, and sets no cookie", async () => {
    const issued = await runEffect(Sessions.use((sessions) => sessions.create));
    const idOf = Effect.map(currentSession, (session) => Response.json({ id: Option.getOrNull(session)?.id ?? null }));
    const withCookie = await runEffectResponse(
      idOf,
      new Request('http://127.0.0.1:3000/api/x', { headers: { cookie: `faceslop_session=${issued.token}` } }),
    );
    expect(await withCookie.json()).toEqual({ id: issued.session.id });
    expect(withCookie.headers.get('set-cookie')).toBeNull();
    const withoutCookie = await runEffectResponse(idOf, new Request('http://127.0.0.1:3000/api/x'));
    expect(await withoutCookie.json()).toEqual({ id: null });
  });
});
