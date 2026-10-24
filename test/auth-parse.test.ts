// Pure login helpers: session cookies, the embedded viewer, and classifying login pages.
// Port of legacy/test/auth-parse.test.ts.
import { describe, expect, it } from 'vitest';
import {
  type LoginSnapshot,
  USE_LOGIN_VIEW,
  classifyLoginStep,
  classifySessionPage,
  isAuthUrl,
  isLoginUrl,
  parseViewer,
  snapshotSignature,
  userIdFromCookies,
} from '@/server/auth/auth-parse';

const now = Date.UTC(2026, 9, 23);

describe('userIdFromCookies', () => {
  it('reads a live c_user cookie', () => {
    expect(userIdFromCookies([{ name: 'xs', value: 'x' }, { name: 'c_user', value: '100012345', expires: now / 1000 + 3600 }], now)).toBe('100012345');
    expect(userIdFromCookies([{ name: 'c_user', value: '100012345', expires: -1 }], now)).toBe('100012345');
  });

  it('ignores missing, zero, malformed and expired cookies', () => {
    expect(userIdFromCookies([], now)).toBeNull();
    expect(userIdFromCookies([{ name: 'c_user', value: '0' }], now)).toBeNull();
    expect(userIdFromCookies([{ name: 'c_user', value: 'deleted' }], now)).toBeNull();
    expect(userIdFromCookies([{ name: 'c_user', value: '100012345', expires: now / 1000 - 1 }], now)).toBeNull();
  });
});

describe('auth URLs', () => {
  it('recognizes login, 2FA and checkpoint pages', () => {
    for (const url of [
      'https://www.facebook.com/login/',
      'https://www.facebook.com/login.php?next=x',
      'https://www.facebook.com/login/device-based/regular/login/?login_attempt=1',
      'https://www.facebook.com/checkpoint/?next',
      'https://www.facebook.com/two_step_verification/two_factor/?encrypted_context=x',
      'https://www.facebook.com/auth_platform/afad/?apc=x',
      'https://www.facebook.com/recover/initiate/',
    ]) {
      expect(isAuthUrl(url), url).toBe(true);
    }
    expect(isLoginUrl('https://www.facebook.com/login/?next=x')).toBe(true);
    expect(isLoginUrl('https://www.facebook.com/checkpoint/')).toBe(false);
  });

  it('does not flag ordinary pages', () => {
    for (const url of ['https://www.facebook.com/marketplace/', 'https://www.facebook.com/', 'https://www.facebook.com/loginfoo', 'about:blank']) {
      expect(isAuthUrl(url), url).toBe(false);
    }
  });
});

// Trimmed from a real logged-out page (2026-10), plus a logged-in variant.
const loggedOutHtml =
  '<script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"define":[["CurrentUserInitialData",[],{"ACCOUNT_ID":"0","USER_ID":"0","NAME":"","SHORT_NAME":null,"IS_BUSINESS_PERSON_ACCOUNT":false,"APP_ID":"2220391788200892"},270]]}}]]]}</script>';
const loggedInHtml =
  '<script>requireLazy(["ServerJS"]);</script><script type="application/json">{"define":[["LSD",[],{"token":"x"},323],["CurrentUserInitialData",[],{"ACCOUNT_ID":"100012345","USER_ID":"100012345","NAME":"Zo\\u00eb \\"Zed\\" O\'Neil","SHORT_NAME":"Zo\\u00eb","IS_BUSINESS_PERSON_ACCOUNT":false},270]]}</script>';

describe('parseViewer / classifySessionPage', () => {
  it('reads the viewer id and name', () => {
    expect(parseViewer(loggedInHtml)).toEqual({ userId: '100012345', name: 'Zoë "Zed" O\'Neil' });
    expect(parseViewer(loggedOutHtml)).toEqual({ userId: '0', name: null });
    expect(parseViewer('<html></html>')).toBeNull();
  });

  it('classifies a page loaded with the saved session', () => {
    const mp = 'https://www.facebook.com/marketplace/';
    expect(classifySessionPage(mp, loggedInHtml)).toEqual({ kind: 'alive', userId: '100012345', name: 'Zoë "Zed" O\'Neil' });
    expect(classifySessionPage(mp, loggedOutHtml)).toEqual({ kind: 'logged_out' });
    expect(classifySessionPage('https://www.facebook.com/login/?next=x', null)).toEqual({ kind: 'logged_out' });
    expect(classifySessionPage('https://www.facebook.com/checkpoint/828281030927956/', '')).toEqual({ kind: 'checkpoint' });
    expect(classifySessionPage(mp, null)).toEqual({ kind: 'unknown' });
    expect(classifySessionPage(mp, '<html>rate limited</html>')).toEqual({ kind: 'unknown' });
  });
});

function snap(partial: Partial<LoginSnapshot>): LoginSnapshot {
  return {
    url: 'https://www.facebook.com/login/',
    text: '',
    buttons: [],
    hasPasswordField: false,
    hasCodeField: false,
    alertText: null,
    hasCaptcha: false,
    hasCookieDialog: false,
    ...partial,
  };
}

describe('classifyLoginStep', () => {
  const loginForm = { hasPasswordField: true, text: 'Log in to Facebook\nEmail or mobile number\nPassword\nLog in\nForgot password?', buttons: ['Log In'] };

  it('is pending on the untouched login form', () => {
    expect(classifyLoginStep(snap(loginForm), false)).toEqual({ kind: 'pending' });
  });

  it('succeeds once there is a session and Facebook has left its login pages', () => {
    expect(classifyLoginStep(snap({ url: 'https://www.facebook.com/marketplace/' }), true)).toEqual({ kind: 'success' });
    expect(classifyLoginStep(snap({ url: 'https://www.facebook.com/' }), true)).toEqual({ kind: 'success' });
    // c_user can exist mid-checkpoint
    expect(classifyLoginStep(snap({ url: 'https://www.facebook.com/checkpoint/?next', hasCodeField: true }), true).kind).toBe('needs_code');
  });

  it("passes Facebook's wrong-credentials message through", () => {
    const alertText = "The password that you've entered is incorrect. Forgot password?";
    expect(classifyLoginStep(snap({ ...loginForm, alertText }), false)).toEqual({ kind: 'failed', message: alertText });
    const text = `${loginForm.text}\nThe email address or mobile number you entered isn't connected to an account. Find your account and log in.`;
    expect(classifyLoginStep(snap({ ...loginForm, text }), false)).toEqual({
      kind: 'failed',
      message: "The email address or mobile number you entered isn't connected to an account.",
    });
  });

  it('asks for a code on 2FA pages, with Facebook’s wording', () => {
    const step = classifyLoginStep(
      snap({
        url: 'https://www.facebook.com/two_step_verification/two_factor/?encrypted_context=x',
        hasCodeField: true,
        text: 'Go to your authentication app\nEnter the 6-digit code for this account from the two-factor authentication app that you set up (such as Duo Mobile or Google Authenticator).\nCode\nContinue\nTry another way',
      }),
      false,
    );
    expect(step).toEqual({
      kind: 'needs_code',
      message:
        'Enter the 6-digit code for this account from the two-factor authentication app that you set up (such as Duo Mobile or Google Authenticator).',
    });
    const wrong = classifyLoginStep(
      snap({ url: 'https://www.facebook.com/checkpoint/?next', hasCodeField: true, alertText: "This code doesn't work. Check it's correct or try a new one." }),
      false,
    );
    expect(wrong).toEqual({ kind: 'needs_code', message: "This code doesn't work. Check it's correct or try a new one." });
  });

  it('waits for approval from another device', () => {
    const step = classifyLoginStep(
      snap({
        url: 'https://www.facebook.com/two_step_verification/authentication/?encrypted_context=x',
        text: 'Check your notifications on another device\nWe sent a notification to your iPhone. Approve the login to continue.\nWaiting for approval\nTry another way',
      }),
      false,
    );
    expect(step.kind).toBe('needs_approval');
  });

  it('answers "trust this device" prompts', () => {
    expect(
      classifyLoginStep(
        snap({
          url: 'https://www.facebook.com/two_step_verification/trust/',
          text: "Trust this device?\nYou won't need to enter a code when you log in from here.",
          buttons: ['Trust this device', "Don't trust"],
        }),
        true,
      ),
    ).toEqual({ kind: 'save_device' });
    expect(
      classifyLoginStep(
        snap({ url: 'https://www.facebook.com/checkpoint/?next', text: 'Remember Browser\nSave Browser\nDon’t Save', buttons: ['Continue'] }),
        false,
      ),
    ).toEqual({ kind: 'save_device' });
  });

  it('gives up on captchas, locked accounts and rate limits, pointing at the login view', () => {
    const captcha = classifyLoginStep(snap({ url: 'https://www.facebook.com/checkpoint/', hasCaptcha: true }), false);
    expect(captcha.kind).toBe('failed');
    expect(captcha.kind === 'failed' && captcha.message).toMatch(/captcha/i);
    expect(captcha.kind === 'failed' && captcha.message).toContain(USE_LOGIN_VIEW);
    const textCaptcha = classifyLoginStep(snap({ url: 'https://www.facebook.com/checkpoint/', text: "Security check\nPlease confirm you're not a robot. I'm not a robot" }), false);
    expect(textCaptcha.kind).toBe('failed');
    const locked = classifyLoginStep(snap({ url: 'https://www.facebook.com/checkpoint/828281030927956/', text: 'Your account has been locked\nWe noticed unusual activity.' }), false);
    expect(locked.kind === 'failed' && locked.message).toMatch(/locked/i);
    expect(locked.kind === 'failed' && locked.message).toContain(USE_LOGIN_VIEW);
    const limited = classifyLoginStep(snap({ ...loginForm, text: `${loginForm.text}\nYou've tried to log in too many times. Try again later.` }), false);
    expect(limited.kind).toBe('failed');
    expect(limited.kind === 'failed' && limited.message).toContain(USE_LOGIN_VIEW);
  });

  it('flags unknown checkpoints and cookie dialogs', () => {
    expect(classifyLoginStep(snap({ url: 'https://www.facebook.com/checkpoint/1501092823525282/', text: 'Confirm your identity\nChoose a way to confirm' }), false).kind).toBe(
      'unknown_checkpoint',
    );
    expect(classifyLoginStep(snap({ ...loginForm, hasCookieDialog: true }), false)).toEqual({ kind: 'cookie_consent' });
  });

  it('fingerprints snapshots', () => {
    expect(snapshotSignature(snap({ text: 'a' }))).toBe(snapshotSignature(snap({ text: 'a' })));
    expect(snapshotSignature(snap({ text: 'a' }))).not.toBe(snapshotSignature(snap({ text: 'a', alertText: 'bad code' })));
  });
});
