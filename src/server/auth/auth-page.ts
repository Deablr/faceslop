// Drives Facebook's login pages in a Playwright page: cookie consent, the login form, the 2FA code
// form and the "trust this device" prompt. Used by Auth.ts; tested against a fake facebook.com
// (test/auth-flow.test.ts). Port of legacy/src/server/fb/auth-page.ts.
//
// These are plain Promise functions (polling loops over a live page); Auth.ts wraps them in
// Effect. Typed values (password, code) never appear in returned messages: Playwright's error text
// includes `fill("<value>")`, so fill errors are swallowed and replaced with generic messages.
import '@tanstack/react-start/server-only';
import type { Locator, Page } from 'playwright';
import {
  type LoginSnapshot,
  type LoginStep,
  USE_LOGIN_VIEW,
  classifyLoginStep,
  isAuthUrl,
  snapshotSignature,
  userIdFromCookies,
} from '@/server/auth/auth-parse';
import { FB_ORIGIN } from '@/server/browser/Browser';
import { runInPage } from '@/server/browser/page-script';

export type PageResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first candidate with a visible match, polling up to `timeoutMs`. */
async function firstVisible(candidates: readonly Locator[], timeoutMs = 0): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of candidates) {
      const el = candidate.filter({ visible: true }).first();
      if ((await el.count().catch(() => 0)) > 0) return el;
    }
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

/** Answer the EU cookie dialog if one is showing (prefers declining optional cookies). */
export async function dismissCookieDialog(page: Page): Promise<boolean> {
  const button = await firstVisible([
    page.locator('[data-cookiebanner="accept_only_essential_button"]'),
    page.getByRole('button', { name: /decline optional cookies|only allow essential cookies|reject optional cookies/i }),
    page.locator('[data-cookiebanner="accept_button"]'),
    page.getByRole('button', { name: /allow all cookies|accept all cookies/i }),
  ]);
  if (!button) return false;
  await button.click({ timeout: 3000 }).catch(() => undefined);
  return true;
}

/** Fill and submit the email/password form on facebook.com/login. */
export async function fillLoginForm(page: Page, email: string, password: string): Promise<PageResult> {
  await dismissCookieDialog(page);
  const pass = await firstVisible(
    [page.locator('#pass'), page.locator('input[name="pass"]'), page.locator('input[type="password"]'), page.getByLabel(/^password$/i)],
    15_000,
  );
  if (!pass) return { ok: false, message: `Couldn't find Facebook's login form. ${USE_LOGIN_VIEW}` };
  // Facebook pages can hold more than one login form (header + modal); stay inside this one.
  const form = pass.locator('xpath=ancestor::form[1]');
  const scope = (await form.count()) > 0 ? form : page.locator('body');

  const emailField = await firstVisible(
    [
      scope.locator('#email'),
      scope.locator('input[name="email"]'),
      scope.getByRole('textbox', { name: /email|phone|mobile|username/i }),
      page.locator('#email'),
      page.locator('input[name="email"]'),
    ],
    2000,
  );
  if (!emailField) return { ok: false, message: `Couldn't find Facebook's login form. ${USE_LOGIN_VIEW}` };

  try {
    await emailField.fill(email, { timeout: 5000 });
    await pass.fill(password, { timeout: 5000 });
  } catch {
    return { ok: false, message: `Couldn't type into Facebook's login form. ${USE_LOGIN_VIEW}` };
  }

  const submit = await firstVisible(
    [
      scope.locator('#loginbutton'),
      scope.locator('button[name="login"]'),
      scope.getByRole('button', { name: /^log ?in$/i }),
      scope.locator('button[type="submit"], input[type="submit"]'),
    ],
    1000,
  );
  try {
    if (submit) await submit.click({ timeout: 5000 });
    else await pass.press('Enter', { timeout: 5000 });
  } catch {
    try {
      await pass.press('Enter', { timeout: 3000 });
    } catch {
      return { ok: false, message: `Couldn't submit Facebook's login form. ${USE_LOGIN_VIEW}` };
    }
  }
  return { ok: true };
}

/** Type a 2FA / login code into the checkpoint page and submit it. */
export async function enterLoginCode(page: Page, code: string): Promise<PageResult> {
  const field = await firstVisible(
    [
      page.locator('input[name="approvals_code"]'),
      page.locator('input[autocomplete="one-time-code"]'),
      page.getByRole('textbox', { name: /code/i }),
      page.getByPlaceholder(/code/i),
      page.locator('input[name*="code" i]'),
      page.locator('input[inputmode="numeric"]'),
    ],
    5000,
  );
  if (!field) return { ok: false, message: `Couldn't find where to enter the code. ${USE_LOGIN_VIEW}` };
  try {
    await field.fill(code, { timeout: 5000 });
  } catch {
    return { ok: false, message: `Couldn't type the code into Facebook's page. ${USE_LOGIN_VIEW}` };
  }

  const form = field.locator('xpath=ancestor::form[1]');
  const inForm = (await form.count()) > 0;
  const submitName = /^(continue|submit( code)?|confirm|next|verify)$/i;
  const submit = await firstVisible(
    [
      page.locator('#checkpointSubmitButton'),
      ...(inForm ? [form.getByRole('button', { name: submitName }), form.locator('button[type="submit"]')] : []),
      page.getByRole('button', { name: submitName }),
    ],
    1000,
  );
  try {
    if (submit) await submit.click({ timeout: 5000 });
    else await field.press('Enter', { timeout: 5000 });
  } catch {
    return { ok: false, message: `Couldn't submit the code. ${USE_LOGIN_VIEW}` };
  }
  return { ok: true };
}

/** Answer "Save browser / Trust this device?" with yes, so Facebook doesn't ask for codes again. */
export async function confirmSaveDevice(page: Page): Promise<boolean> {
  const radio = page.locator('input[type="radio"][value="save_device"]');
  if ((await radio.count()) > 0) await radio.first().check({ force: true, timeout: 2000 }).catch(() => undefined);
  const button = await firstVisible(
    [
      page.getByRole('button', { name: /^trust this device$/i }),
      page.getByRole('button', { name: /^(save browser|remember browser)$/i }),
      page.locator('#checkpointSubmitButton'),
      page.getByRole('button', { name: /^(save|continue|ok)$/i }),
    ],
    2000,
  );
  if (!button) return false;
  await button.click({ timeout: 5000 }).catch(() => undefined);
  return true;
}

/** Runs inside the page (self-contained, see page-script.ts): what the login page is currently showing. */
function readLoginPage(): LoginSnapshot {
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const describe = (input: HTMLInputElement) =>
    clean(
      [
        input.name,
        input.id,
        input.getAttribute('aria-label'),
        input.placeholder,
        input.autocomplete,
        ...Array.from(input.labels ?? []).map((label) => label.textContent),
      ].join(' '),
    );
  const hasCodeField = inputs.some((input) => {
    if (!['text', 'tel', 'number'].includes(input.type)) return false;
    const label = describe(input);
    if (/captcha|email|user|search/i.test(label)) return false;
    return (
      input.autocomplete === 'one-time-code' ||
      /approvals_code|\bcode\b/i.test(label) ||
      (input.inputMode === 'numeric' && [6, 8].includes(input.maxLength))
    );
  });

  const alerts: string[] = [];
  for (const el of Array.from(document.querySelectorAll('[role="alert"], #error_box, [data-testid="royal_login_error"]'))) {
    if (visible(el)) alerts.push(clean(el.textContent));
  }
  // Newer forms mark the bad field aria-invalid and point at the explanation.
  for (const input of Array.from(document.querySelectorAll('input[aria-invalid="true"]'))) {
    for (const id of (input.getAttribute('aria-describedby') ?? '').split(/\s+/)) {
      const description = id === '' ? null : document.getElementById(id);
      if (description) alerts.push(clean(description.textContent));
    }
  }

  const labelOf = (el: Element) => {
    const aria = el.getAttribute('aria-label');
    if (aria !== null && aria !== '') return clean(aria);
    return clean(el instanceof HTMLInputElement ? el.value : el.textContent);
  };
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
    .filter(visible)
    .map(labelOf)
    .filter((label) => label !== '')
    .slice(0, 60);

  const hasCaptcha = Array.from(
    document.querySelectorAll(
      'iframe[src*="captcha" i], iframe[title*="captcha" i], img[src*="captcha" i], input[name*="captcha" i], #captcha',
    ),
  ).some(visible);

  const consentButton = /allow all cookies|decline optional cookies|only allow essential cookies|accept all cookies/i;
  const hasCookieDialog = Array.from(
    document.querySelectorAll('[data-cookiebanner], [data-testid="cookie-policy-manage-dialog"], [role="dialog"]'),
  ).some(
    (el) =>
      visible(el) &&
      (!el.matches('[role="dialog"]') ||
        Array.from(el.querySelectorAll('button, [role="button"]')).some((b) => consentButton.test(labelOf(b)))),
  );

  // Typed non-null, but missing while the document is still being parsed.
  const body = document.body as HTMLElement | null;
  const text = (body?.innerText ?? '').split('\n').map(clean).filter(Boolean).join('\n').slice(0, 6000);

  return {
    url: location.href,
    text,
    buttons,
    hasPasswordField: inputs.some((input) => input.type === 'password'),
    hasCodeField,
    alertText: alerts.find((t) => t.length > 3)?.slice(0, 300) ?? null,
    hasCaptcha,
    hasCookieDialog,
  };
}

export function readLoginSnapshot(page: Page): Promise<LoginSnapshot> {
  return runInPage(page, readLoginPage);
}

/** Classify the login page right now. `signature` is null when the page couldn't be read (mid-navigation). */
export async function readLoginStep(page: Page): Promise<{ readonly step: LoginStep; readonly signature: string | null }> {
  const hasSession = userIdFromCookies(await page.context().cookies(FB_ORIGIN).catch(() => [])) !== null;
  let snapshot: LoginSnapshot | null = null;
  try {
    snapshot = await readLoginSnapshot(page);
  } catch {
    // navigating; try again on the next poll
  }
  if (!snapshot) {
    const done = hasSession && !page.isClosed() && !isAuthUrl(page.url());
    return { step: done ? { kind: 'success' } : { kind: 'pending' }, signature: null };
  }
  return { step: classifyLoginStep(snapshot, hasSession), signature: snapshotSignature(snapshot) };
}

export type LoginOutcome = Extract<LoginStep, { readonly kind: 'success' | 'needs_code' | 'needs_approval' | 'failed' }>;

export interface OutcomeOptions {
  readonly timeoutMs?: number;
  /** Signature of the page before submitting; a prompt on an unchanged page is ignored for `staleMs`. */
  readonly before?: string | null;
  readonly staleMs?: number;
  /** How long an unrecognized checkpoint must persist before giving up. */
  readonly settleMs?: number;
  readonly pollMs?: number;
}

/**
 * After submitting the form or a code: wait until Facebook logs us in, asks for something, or
 * fails. Answers cookie and "trust this device" prompts along the way.
 */
export async function waitForLoginOutcome(page: Page, options: OutcomeOptions = {}): Promise<LoginOutcome> {
  const { timeoutMs = 45_000, before = null, staleMs = 15_000, settleMs = 6000, pollMs = 600 } = options;
  const started = Date.now();
  let unknownSince = 0;
  let saveClicks = 0;
  let consentClicks = 0;

  while (Date.now() - started < timeoutMs) {
    if (page.isClosed()) return { kind: 'failed', message: 'The login page closed unexpectedly. Try again.' };
    const { step, signature } = await readLoginStep(page);
    if (step.kind !== 'unknown_checkpoint') unknownSince = 0;

    switch (step.kind) {
      case 'success':
      case 'failed':
        return step;
      case 'needs_code':
      case 'needs_approval':
        // The old page may still be showing right after a submit; wait for it to change.
        if (before === null || signature !== before) return step;
        if (Date.now() - started >= staleMs) {
          return step.kind === 'needs_code'
            ? { kind: 'needs_code', message: "Facebook didn't accept that code. Check it and try again." }
            : step;
        }
        break;
      case 'save_device':
        if (saveClicks++ >= 3) return { kind: 'failed', message: `Facebook kept asking to save this browser. ${USE_LOGIN_VIEW}` };
        await confirmSaveDevice(page);
        break;
      case 'cookie_consent':
        if (consentClicks++ < 3) await dismissCookieDialog(page);
        break;
      case 'unknown_checkpoint':
        if (unknownSince === 0) unknownSince = Date.now();
        if (Date.now() - unknownSince >= settleMs) return { kind: 'failed', message: step.message };
        break;
      case 'pending':
        break;
    }
    await sleep(pollMs);
  }
  return { kind: 'failed', message: `Facebook didn't finish the login in time. ${USE_LOGIN_VIEW}` };
}
