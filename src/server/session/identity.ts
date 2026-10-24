// Who is asking: browser sessions, Facebook accounts, and who owns local data. Pure types and
// helpers (no services). OWNER: contracts.
//
// - A ClientSession is one browser (the `faceslop_session` cookie). It is created lazily: when the
//   app password is entered, or on the first request that needs one (a write, opening a remote
//   view, logging in to Facebook). Requests without one browse anonymously and read empty lists.
// - After a successful Facebook login in that browser, the session is BOUND to the Facebook
//   account (its c_user id). Logging out of Facebook on that device unbinds it.
// - FbProfile: whose Facebook cookies a browser context carries. Bound sessions use their
//   account's profile; everyone else shares the anonymous (logged-out) profile.
// - OwnerKey: who owns local data (favorites, saved searches, hidden listings, blocked sellers,
//   settings). A bound session's data belongs to its Facebook account (shared by every device
//   logged in to that account); an unbound session's data belongs to that browser alone and moves
//   to the account when it logs in.
import '@tanstack/react-start/server-only';
import type { Brand } from 'effect';

/** A Facebook user id: the value of the `c_user` cookie (digits). */
export type FbUserId = string & Brand.Brand<'FbUserId'>;

const FB_USER_ID_PATTERN = /^\d{1,32}$/;

/** A c_user cookie value as an FbUserId, or null when it isn't one. */
export function fbUserIdOf(value: string | null | undefined): FbUserId | null {
  return value !== null && value !== undefined && FB_USER_ID_PATTERN.test(value) ? (value as FbUserId) : null;
}

/** A browser session's id: random, NOT the cookie token (only the token's SHA-256 is stored). */
export type ClientSessionId = string & Brand.Brand<'ClientSessionId'>;

export interface ClientSession {
  readonly id: ClientSessionId;
  /** Entered the current APP_PASSWORD (always true when none is set). Never expires. */
  readonly unlocked: boolean;
  /** The Facebook account this browser logged in with; null until then and after logging out. */
  readonly fbUserId: FbUserId | null;
}

/** Whose Facebook cookies a browser context carries. */
export type FbProfile = { readonly kind: 'anonymous' } | { readonly kind: 'account'; readonly userId: FbUserId };

export const ANONYMOUS_PROFILE: FbProfile = { kind: 'anonymous' };

export const accountProfile = (userId: FbUserId): FbProfile => ({ kind: 'account', userId });

/** A stable map key for a profile: "anonymous" or "fb:<id>". */
export const profileKey = (profile: FbProfile): string =>
  profile.kind === 'anonymous' ? 'anonymous' : `fb:${profile.userId}`;

export const sameProfile = (a: FbProfile, b: FbProfile): boolean => profileKey(a) === profileKey(b);

/** The profile a session's Facebook work runs under (no session: anonymous). */
export const profileOf = (session: ClientSession | null): FbProfile => {
  const userId = session?.fbUserId ?? null;
  return userId === null ? ANONYMOUS_PROFILE : accountProfile(userId);
};

/** Owner of local data rows (the `owner` column): "fb:<id>", "session:<id>", or UNCLAIMED_OWNER. */
export type OwnerKey = string & Brand.Brand<'OwnerKey'>;

export const accountOwner = (userId: FbUserId): OwnerKey => `fb:${userId}` as OwnerKey;

export const sessionOwner = (id: ClientSessionId): OwnerKey => `session:${id}` as OwnerKey;

/**
 * Rows from before multi-user support (single-user installs). The first Facebook account that
 * logs in claims them (ClientSessionsRepo.reassignOwner), so an existing user keeps their data.
 */
export const UNCLAIMED_OWNER = '' as OwnerKey;

/** Who owns a session's local data: its Facebook account when bound, else the session itself. */
export const ownerOf = (session: ClientSession): OwnerKey =>
  session.fbUserId === null ? sessionOwner(session.id) : accountOwner(session.fbUserId);

/** The Facebook account behind an owner key, if it is an account owner. */
export function accountOfOwner(owner: OwnerKey): FbUserId | null {
  return owner.startsWith('fb:') ? fbUserIdOf(owner.slice(3)) : null;
}

/** The profile background work for an owner runs under (account owners: their account). */
export const profileOfOwner = (owner: OwnerKey): FbProfile => {
  const userId = accountOfOwner(owner);
  return userId === null ? ANONYMOUS_PROFILE : accountProfile(userId);
};
