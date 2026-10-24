// Pure helpers for Facebook login: session cookies, the viewer embedded in pages, and classifying
// what a login page is asking for. No Playwright or Effect here (unit-tested in
// test/auth-parse.test.ts). Port of legacy/src/server/fb/auth-parse.ts.
import '@tanstack/react-start/server-only';

export interface CookieLike {
  readonly name: string;
  readonly value: string;
  /** Unix seconds; -1 for session cookies. */
  readonly expires?: number;
}

/** The logged-in user id from a live c_user cookie, or null. */
export function userIdFromCookies(cookies: readonly CookieLike[], now = Date.now()): string | null {
  const cookie = cookies.find((c) => c.name === 'c_user');
  if (!cookie || !/^\d+$/.test(cookie.value) || cookie.value === '0') return null;
  if (cookie.expires !== undefined && cookie.expires > 0 && cookie.expires * 1000 < now) return null;
  return cookie.value;
}

/** The session secret (the xs cookie) of one login, or null. Logging in again gives a new one. */
export function sessionTokenFromCookies(cookies: readonly CookieLike[]): string | null {
  const value = cookies.find((c) => c.name === 'xs')?.value;
  return value === undefined || value === '' ? null : value;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

export function isLoginUrl(url: string): boolean {
  return /^\/login(\.php)?(\/|$)/.test(pathOf(url));
}

/** Login, 2FA and checkpoint pages. A c_user cookie while on one of these doesn't mean the login is finished. */
export function isAuthUrl(url: string): boolean {
  return (
    isLoginUrl(url) || /^\/(checkpoint|two_step_verification|two_factor|auth_platform|recover)(\/|$)/.test(pathOf(url))
  );
}

export interface Viewer {
  /** "0" when logged out. */
  readonly userId: string;
  readonly name: string | null;
}

/** The viewer from the `CurrentUserInitialData` blob every facebook.com page embeds. */
export function parseViewer(html: string): Viewer | null {
  const start = html.indexOf('"CurrentUserInitialData"');
  if (start < 0) return null;
  const chunk = html.slice(start, start + 4000);
  const userId = /"USER_ID":"(\d+)"/.exec(chunk)?.[1];
  if (userId === undefined) return null;
  let name: string | null = null;
  const rawName = /"NAME":("(?:[^"\\]|\\.)*")/.exec(chunk)?.[1];
  if (rawName !== undefined) {
    try {
      const parsed: unknown = JSON.parse(rawName);
      name = typeof parsed === 'string' && parsed.trim() !== '' ? parsed.trim() : null;
    } catch {
      name = null;
    }
  }
  return { userId, name };
}

export type SessionCheck =
  | { readonly kind: 'alive'; readonly userId: string; readonly name: string | null }
  | { readonly kind: 'logged_out' }
  /** Facebook wants the user to confirm something (security checkpoint); the session may recover. */
  | { readonly kind: 'checkpoint' }
  /** Couldn't tell (network error, unexpected page). */
  | { readonly kind: 'unknown' };

/** Classify a facebook.com page load made with the saved session. */
export function classifySessionPage(finalUrl: string, html: string | null): SessionCheck {
  if (isLoginUrl(finalUrl)) return { kind: 'logged_out' };
  if (isAuthUrl(finalUrl)) return { kind: 'checkpoint' };
  const viewer = html === null ? null : parseViewer(html);
  if (!viewer) return { kind: 'unknown' };
  if (viewer.userId === '0') return { kind: 'logged_out' };
  return { kind: 'alive', userId: viewer.userId, name: viewer.name };
}

// ---------- login steps ----------

/** What the login page currently shows (gathered in the page by auth-page.ts). */
export interface LoginSnapshot {
  readonly url: string;
  /** Visible page text: one line per block, whitespace-collapsed, truncated. */
  readonly text: string;
  /** Labels of visible buttons. */
  readonly buttons: readonly string[];
  readonly hasPasswordField: boolean;
  readonly hasCodeField: boolean;
  /** Error text shown next to the form (role=alert, invalid-field descriptions). */
  readonly alertText: string | null;
  readonly hasCaptcha: boolean;
  readonly hasCookieDialog: boolean;
}

export type LoginStep =
  | { readonly kind: 'success' }
  | { readonly kind: 'needs_code'; readonly message: string }
  | { readonly kind: 'needs_approval'; readonly message: string }
  /** "Save browser / Trust this device?": answer it and keep going. */
  | { readonly kind: 'save_device' }
  | { readonly kind: 'cookie_consent' }
  /** Definitive failure: wrong credentials, captcha, locked account, rate limit. */
  | { readonly kind: 'failed'; readonly message: string }
  /** An auth page we don't understand. Only treat as failure once the page has settled. */
  | { readonly kind: 'unknown_checkpoint'; readonly message: string }
  /** Still loading / still on the form with nothing to report. */
  | { readonly kind: 'pending' };

/**
 * Appended to failures the hidden login can't get past (captcha, unknown checkpoints, rate
 * limits): the remote login view (openRemoteView { target: 'login' }) shows Facebook's own page.
 */
export const USE_LOGIN_VIEW = "Log in through Facebook's own login page instead.";

const CAPTCHA_TEXT = /captcha|i'?m not a robot|enter the (characters|text|letters) (you see|in the image|shown)/i;
const LOCKED_TEXT =
  /account (has been |was |is )?(temporarily )?(locked|disabled|suspended)|we suspended your account|your account is restricted/i;
const RATE_LIMIT_TEXT = /too many (login )?attempts|you'?ve (tried|been trying) .{0,40}too many|try again later|temporarily blocked/i;
const WRONG_CREDENTIALS_TEXT =
  /(password|email|mobile number|phone number|username)[^.]{0,80}(incorrect|isn'?t (right|correct|connected)|doesn'?t match|invalid|wrong|not connected)|wrong credentials|invalid username or password/i;
const SAVE_DEVICE_TEXT = /save (this )?browser|trust this device|remember (this )?(browser|device)|save your login info/i;
const SAVE_DEVICE_BUTTON = /^(trust this device|save browser|remember browser|save|ok|continue)$/i;
const APPROVAL_TEXT =
  /check your notifications|approve (the |this |your )?log ?in|approve from|waiting for approval|on another device|go to your facebook app|we sent a notification/i;

const DEFAULT_CODE_MESSAGE = 'Facebook sent you a login code. Enter it to finish logging in.';
const APPROVAL_MESSAGE =
  'Facebook wants you to approve this login from another device. Open Facebook on your phone (check your notifications) and confirm it was you. This updates by itself.';

/** The first sentence of `text` that matches `re`, for passing Facebook's own wording through. */
function sentenceMatching(text: string, re: RegExp): string | null {
  for (const sentence of text.split(/\n|(?<=[.!?])\s+/)) {
    if (re.test(sentence) && sentence.length <= 220) return sentence.trim();
  }
  return null;
}

export function classifyLoginStep(s: LoginSnapshot, hasSession: boolean): LoginStep {
  if (hasSession && !isAuthUrl(s.url)) return { kind: 'success' };
  if (s.hasCaptcha || (!s.hasCodeField && CAPTCHA_TEXT.test(s.text))) {
    return { kind: 'failed', message: `Facebook wants a security check (captcha). ${USE_LOGIN_VIEW}` };
  }
  if (LOCKED_TEXT.test(s.text)) {
    const detail = sentenceMatching(s.text, LOCKED_TEXT) ?? 'Facebook says your account is locked.';
    return { kind: 'failed', message: `${detail} ${USE_LOGIN_VIEW}` };
  }
  if (s.hasCookieDialog) return { kind: 'cookie_consent' };
  if (s.hasCodeField) {
    const message = s.alertText ?? sentenceMatching(s.text, /\bcode\b/i) ?? DEFAULT_CODE_MESSAGE;
    return { kind: 'needs_code', message };
  }
  if (SAVE_DEVICE_TEXT.test(s.text) && s.buttons.some((b) => SAVE_DEVICE_BUTTON.test(b))) {
    return { kind: 'save_device' };
  }
  if (APPROVAL_TEXT.test(s.text) && !s.hasPasswordField) return { kind: 'needs_approval', message: APPROVAL_MESSAGE };

  if (isLoginUrl(s.url) || s.hasPasswordField) {
    if (s.alertText !== null) return { kind: 'failed', message: s.alertText };
    const wrong = sentenceMatching(s.text, WRONG_CREDENTIALS_TEXT);
    if (wrong !== null) return { kind: 'failed', message: wrong };
    const limited = sentenceMatching(s.text, RATE_LIMIT_TEXT);
    if (limited !== null) return { kind: 'failed', message: `${limited} ${USE_LOGIN_VIEW}` };
    return { kind: 'pending' };
  }
  if (isAuthUrl(s.url)) {
    return { kind: 'unknown_checkpoint', message: `Facebook is asking for an extra check this app can't answer. ${USE_LOGIN_VIEW}` };
  }
  return { kind: 'pending' };
}

/** A cheap fingerprint of a snapshot, to notice when the page has reacted to a submission. */
export function snapshotSignature(s: LoginSnapshot): string {
  return `${s.url}\n${s.alertText ?? ''}\n${s.text.slice(0, 1500)}`;
}
