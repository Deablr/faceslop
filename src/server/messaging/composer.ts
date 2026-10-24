// Finds Facebook's "Send seller a message" composer on a listing page, types our text, presses
// Send exactly once, and confirms the message went through. It works on whatever page it's given,
// so it's tested against local fixtures (test/fixtures/messaging-*.html, test/messaging-composer.test.ts).
// Port of legacy/src/server/fb/messaging-composer.ts; Messaging.ts wraps it in Effect.
//
// Elements are located inside the page (several strategies, see markComposer) and tagged with
// data-faceslop-* attributes; Playwright then acts on the tagged elements. Log lines never contain
// the message text.
import '@tanstack/react-start/server-only';
import { Option, Schema } from 'effect';
import type { Locator, Page, Request, Response } from 'playwright';
import { runInPage } from '@/server/browser/page-script';
import type { SendMessageResult } from '@/shared/domain';

export const ALREADY_MESSAGED =
  "You've already messaged this seller about this listing. Continue the conversation in your Marketplace inbox.";
const NO_COMPOSER =
  "Couldn't find Facebook's message box on this listing. Open the listing in the Marketplace view to message the seller.";
const UNCONFIRMED =
  "Facebook didn't confirm the message was sent. Check the conversation in the Marketplace view before trying again.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
const fail = (message: string): SendMessageResult => ({ ok: false, message, fallbackToWindow: true });

// ---------- in-page functions (self-contained; run via runInPage) ----------

interface MarkResult {
  /** Which strategy found the composer, null when none did. */
  strategy: string | null;
  /** contenteditable / role=textbox rather than textarea/input. */
  rich: boolean;
  /** "Message again" / "See conversation"-style text when the seller was already messaged. */
  already: string | null;
  /** Facebook says the listing is gone. */
  unavailable: string | null;
  /** A plain "Message" button exists (tagged data-faceslop-open) that may open a composer. */
  canOpen: boolean;
}

/**
 * Locate the composer and tag it (data-faceslop-input). `scope` 'page' searches the listing
 * (role=main); 'new-dialog' searches dialogs that appeared since tagDialogs() ran — never
 * pre-existing ones, which may be chats with other people.
 */
function markComposer(scope: 'page' | 'new-dialog'): MarkResult {
  for (const attr of ['data-faceslop-input', 'data-faceslop-send', 'data-faceslop-open']) {
    for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
  }
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const nonEmpty = (value: string | null) => (value === null || value === '' ? null : value);
  const isField = (el: Element): el is HTMLTextAreaElement | HTMLInputElement =>
    el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  const valueOf = (el: Element) => (isField(el) ? el.value : (el as HTMLElement).innerText);
  const labelOf = (el: Element) =>
    clean(
      [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-placeholder'),
        ...(isField(el) ? Array.from(el.labels ?? []).map((label) => label.textContent) : []),
      ].join(' '),
    );
  const entriesIn = (root: Element) => {
    const found = Array.from(
      root.querySelectorAll(
        'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
      ),
    ).filter(
      (el) =>
        visible(el) &&
        !el.matches('[role="combobox"], [type="search"], [aria-label*="search" i], [name="email"], [autocomplete^="username"]'),
    );
    // A textbox wrapper around the real editable: keep the innermost.
    return found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  };
  const textNodes = (root: Element) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return nodes;
  };
  const mark = (input: Element, strategy: string): MarkResult => {
    input.setAttribute('data-faceslop-input', strategy);
    return { strategy, rich: !isField(input), already: null, unavailable: null, canOpen: false };
  };

  const main = document.querySelector('[role="main"]') ?? document.body;
  const roots =
    scope === 'page'
      ? [main]
      : Array.from(document.querySelectorAll('[role="dialog"]')).filter(
          (dialog) =>
            visible(dialog) && !dialog.hasAttribute('data-faceslop-seen') && !dialog.querySelector('input[type="password"]'),
        );

  const HEADING = /send (the )?seller a message|message the seller|contact (the )?seller/i;
  const LABEL = /seller|message|is (this|it) (still )?available/i;
  const PREFILL = /is (this|it) (still )?available/i;

  for (const root of roots) {
    // 1. From the "Send seller a message" heading, climb to the nearest block holding one text box.
    for (const node of textNodes(root)) {
      const text = clean(node.textContent);
      const heading = node.parentElement;
      if (!heading || text.length > 80 || !HEADING.test(text) || !visible(heading)) continue;
      let block: Element | null = heading;
      for (let depth = 0; block && depth < 8; depth++, block = block.parentElement) {
        const entries = entriesIn(block);
        const [only, ...others] = entries;
        if (only && others.length === 0) return mark(only, 'heading');
        if (entries.length > 1 || block === root) break;
      }
    }
    const entries = entriesIn(root);
    // 2. A text box labelled for messaging the seller.
    const labelled = entries.find((el) => LABEL.test(labelOf(el)));
    if (labelled) return mark(labelled, 'label');
    // 3. Facebook's prefilled "Hi, is this available?".
    const prefilled = entries.find((el) => PREFILL.test(valueOf(el)));
    if (prefilled) return mark(prefilled, 'prefill');
    // 4. A dialog we just opened that holds a single text box.
    const [single, ...rest] = entries;
    if (scope === 'new-dialog' && single && rest.length === 0) return mark(single, 'dialog');
  }

  const result: MarkResult = { strategy: null, rich: false, already: null, unavailable: null, canOpen: false };
  if (scope !== 'page') return result;

  const ALREADY = /^(message again|see conversation|view conversation|go to conversation|message sent|you messaged (this )?seller\b.*)$/i;
  for (const node of textNodes(main)) {
    const text = clean(node.textContent);
    if (text.length < 60 && ALREADY.test(text) && node.parentElement && visible(node.parentElement)) {
      result.already = text;
      break;
    }
  }
  const UNAVAILABLE =
    /this listing (is )?no longer available|this listing (has been|was) (removed|deleted)|this content isn'?t available|listing isn'?t available/i;
  result.unavailable = UNAVAILABLE.exec((main as HTMLElement).innerText)?.[0] ?? null;

  const OPEN = /^(message|message seller|send message|contact seller)$/i;
  const opener = Array.from(main.querySelectorAll('[role="button"], button')).find(
    (el) => visible(el) && OPEN.test(clean(nonEmpty(el.getAttribute('aria-label')) ?? el.textContent)),
  );
  if (opener) {
    opener.setAttribute('data-faceslop-open', '');
    result.canOpen = true;
  }
  return result;
}

/** Remember which dialogs already exist (e.g. open chats), so only a newly opened one is used. */
function tagDialogs(): void {
  for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) dialog.setAttribute('data-faceslop-seen', '');
}

/** Tag the Send button that belongs to the tagged composer; returns its label. */
function markSendButton(): string | null {
  for (const el of Array.from(document.querySelectorAll('[data-faceslop-send]'))) el.removeAttribute('data-faceslop-send');
  const input = document.querySelector('[data-faceslop-input]');
  if (!input) return null;
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const nonEmpty = (value: string | null) => (value === null || value === '' ? null : value);
  const nameOf = (el: Element) =>
    clean(nonEmpty(el.getAttribute('aria-label')) ?? (el instanceof HTMLInputElement ? el.value : el.textContent));
  const SEND = /^(send|send message|press enter to send)$/i;
  const usable = (el: Element) =>
    visible(el) && el.getAttribute('aria-disabled') !== 'true' && !(el as HTMLButtonElement).disabled && SEND.test(nameOf(el));

  // The nearest enclosing block with a Send button, without leaving the listing / dialog.
  for (let node = input.parentElement, depth = 0; node && depth < 10; node = node.parentElement, depth++) {
    const buttons = Array.from(node.querySelectorAll('[role="button"], button, input[type="submit"]')).filter(usable);
    // Prefer the first button after the text box.
    const button = buttons.find((b) => input.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ?? buttons[0];
    if (button !== undefined) {
      button.setAttribute('data-faceslop-send', '');
      return nameOf(button);
    }
    if (node.matches('[role="main"], [role="dialog"], body')) break;
  }
  return null;
}

function readInputValue(): string | null {
  const input = document.querySelector('[data-faceslop-input]');
  if (!input) return null;
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement
    ? input.value
    : (input as HTMLElement).innerText;
}

interface SentState {
  composerPresent: boolean;
  inputHasText: boolean;
  /** "Message sent" / "See conversation"-style text. */
  sentText: string | null;
  errorText: string | null;
  /** Text nodes outside the composer containing the start of our message. */
  echoes: number;
}

function readSentState(probe: string): SentState {
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const input = document.querySelector('[data-faceslop-input]');
  const inputText =
    input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : (input as HTMLElement | null)?.innerText;

  const SENT = /^(message sent|sent|see conversation|view conversation|go to conversation|message again|you messaged (this )?seller\b.*)$/i;
  let sentText: string | null = null;
  let echoes = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = clean(node.textContent);
    if (!text || !parent || input?.contains(parent) === true) continue;
    const isSent = !sentText && text.length < 60 && SENT.test(text);
    const isEcho = probe.length > 0 && text.includes(probe);
    if ((isSent || isEcho) && visible(parent)) {
      if (isSent) sentText = text;
      if (isEcho) echoes++;
    }
  }

  const ERROR =
    /couldn'?t send|could not send|unable to send|can'?t send|message (failed|not sent)|something went wrong|try again later|you can'?t message|temporarily blocked|not delivered/i;
  let errorText: string | null = null;
  for (const el of Array.from(document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="dialog"]'))) {
    const text = clean(el.textContent);
    if (ERROR.test(text) && visible(el)) {
      errorText = text.slice(0, 200);
      break;
    }
  }

  return {
    composerPresent: !!input && input.isConnected && visible(input),
    inputHasText: clean(inputText).length > 0,
    sentText,
    errorText,
    echoes,
  };
}

// ---------- GraphQL confirmation ----------

/** The GraphQL operation name of a request (header, or the form-encoded body). */
export function friendlyName(headers: Record<string, string>, postData: string | null): string | null {
  const header = headers['x-fb-friendly-name'];
  if (header) return header;
  if (!postData) return null;
  return new URLSearchParams(postData).get('fb_api_req_friendly_name');
}

/** Whether a GraphQL operation looks like sending a message (not read receipts, typing, badges...). */
export function isSendMutationName(name: string): boolean {
  if (/send|contact.?seller/i.test(name)) return true;
  return /message/i.test(name) && /mutation/i.test(name) && !/seen|read|typing|deliver|presence|badge|count|mute|archive|delete/i.test(name);
}

/** One document of a GraphQL response: only the error fields matter (`data` is ignored). */
const GraphqlDocument = Schema.Struct({
  errors: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  error: Schema.optionalKey(Schema.Unknown),
  errorSummary: Schema.optionalKey(Schema.String),
  errorDescription: Schema.optionalKey(Schema.String),
});
const GraphqlError = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.String),
});
const decodeGraphqlDocument = Schema.decodeUnknownOption(GraphqlDocument);
const decodeGraphqlError = Schema.decodeUnknownOption(GraphqlError);

const GRAPHQL_ERROR = 'Facebook returned an error.';

/** The first value that is a non-empty string. */
const firstText = (...values: readonly (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value !== '');

/** The message of the first error entry that isn't a warning (an entry of another shape counts too), or null. */
function criticalError(errors: readonly unknown[]): string | null {
  for (const entry of errors) {
    const decoded = decodeGraphqlError(entry);
    if (Option.isNone(decoded)) return GRAPHQL_ERROR;
    const { severity, description, summary, message } = decoded.value;
    if (severity !== 'WARNING') return firstText(description, summary, message) ?? GRAPHQL_ERROR;
  }
  return null;
}

/** Read a GraphQL response body (possibly several JSON documents, one per line). */
export function graphqlOutcome(body: string): { ok: boolean; error: string | null } {
  const text = body.replace(/^for \(;;\);/, '');
  const docs: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      docs.push(JSON.parse(line));
    } catch {
      // not line-delimited; handled below
    }
  }
  if (!docs.length) {
    try {
      docs.push(JSON.parse(text));
    } catch {
      return { ok: false, error: null };
    }
  }
  for (const doc of docs) {
    // Not an object of the expected shape (e.g. `null`): nothing to conclude from this response.
    const decoded = decodeGraphqlDocument(doc);
    if (Option.isNone(decoded)) return { ok: false, error: null };
    const { errors = [], error, errorSummary, errorDescription } = decoded.value;
    const critical = criticalError(errors);
    if (critical !== null) return { ok: false, error: critical };
    const summary = firstText(errorDescription, errorSummary);
    if (summary !== undefined || typeof error === 'number') return { ok: false, error: summary ?? GRAPHQL_ERROR };
  }
  return { ok: true, error: null };
}

function watchGraphql(page: Page, log: (line: string) => void) {
  const result = { ok: false, error: null as string | null };
  let armed = false;
  const names = new WeakMap<Request, string>();
  const onRequest = (request: Request) => {
    if (!armed || request.method() !== 'POST' || !request.url().includes('/api/graphql')) return;
    const name = friendlyName(request.headers(), request.postData());
    if (name && isSendMutationName(name)) names.set(request, name);
  };
  const onResponse = (response: Response) => {
    const name = names.get(response.request());
    if (!name) return;
    void response
      .text()
      .then((body) => {
        const outcome = response.status() >= 400 ? { ok: false, error: `HTTP ${response.status()}` } : graphqlOutcome(body);
        if (outcome.error) result.error ??= outcome.error;
        else if (outcome.ok) result.ok = true;
        log(`graphql ${name}: ${outcome.error ? 'error' : outcome.ok ? 'ok' : 'unreadable'}`);
      })
      .catch(() => undefined);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    result,
    /** Only count requests made after this (i.e. after pressing Send). */
    arm: () => {
      armed = true;
    },
    dispose: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}

// ---------- the flow ----------

export interface ComposerOptions {
  /** How long to wait for the composer to render. */
  findTimeoutMs?: number;
  /** How long to wait for Facebook to confirm the send. */
  confirmTimeoutMs?: number;
  /** Debug lines (never contain the message text). */
  log?: (line: string) => void;
}

async function findComposer(page: Page, timeoutMs: number): Promise<MarkResult> {
  const started = Date.now();
  // Give the composer a moment to render before settling for the "Message" button.
  const openAfterMs = Math.min(5000, timeoutMs);
  for (;;) {
    const found = await runInPage(page, markComposer, 'page').catch(() => null);
    const elapsed = Date.now() - started;
    if (found && (found.strategy || found.already || found.unavailable)) return found;
    if (found?.canOpen && elapsed >= openAfterMs) return found;
    if (elapsed >= timeoutMs) return found ?? { strategy: null, rich: false, already: null, unavailable: null, canOpen: false };
    await sleep(500);
  }
}

/** Some layouts only show a "Message" button that opens the composer in a dialog. */
async function openComposer(page: Page, fallback: MarkResult, timeoutMs: number): Promise<MarkResult> {
  await runInPage(page, tagDialogs);
  try {
    await page.locator('[data-faceslop-open]').first().click({ timeout: 5000 });
  } catch {
    return fallback;
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(400);
    for (const scope of ['new-dialog', 'page'] as const) {
      const found = await runInPage(page, markComposer, scope).catch(() => null);
      if (found?.strategy) return { ...found, strategy: `message-button+${found.strategy}` };
    }
  }
  return { ...fallback, canOpen: false };
}

async function typeMessage(page: Page, input: Locator, rich: boolean, text: string): Promise<boolean> {
  const matches = async () => normalize((await runInPage(page, readInputValue).catch(() => null)) ?? '') === normalize(text);
  // Errors are swallowed on purpose: Playwright's fill() error text includes the typed value.
  try {
    await input.fill(text, { timeout: 5000 });
    if (await matches()) return true;
  } catch {
    // fall through
  }
  if (!rich) return false;
  // Rich editors sometimes ignore fill(); type it like a person would.
  try {
    await input.click({ timeout: 3000 });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(text);
  } catch {
    return false;
  }
  return matches();
}

/** The start of the message, used to spot it echoed in the conversation after sending. */
function probeOf(text: string): string {
  const probe = normalize(text).slice(0, 40);
  return probe.length >= 8 ? probe : '';
}

/**
 * Type `text` into the listing's message composer on `page` (already loaded), press Send once,
 * and confirm. Never throws for page problems: returns ok:false + fallbackToWindow instead.
 */
export async function sendViaComposer(page: Page, text: string, opts: ComposerOptions = {}): Promise<SendMessageResult> {
  const {
    findTimeoutMs = 15_000,
    confirmTimeoutMs = 15_000,
    log = (line: string) => {
      console.info(`[messaging] ${line}`);
    },
  } = opts;
  const graphql = watchGraphql(page, log);
  try {
    let found = await findComposer(page, findTimeoutMs);
    if (!found.strategy && found.canOpen && !found.already && !found.unavailable) {
      found = await openComposer(page, found, Math.min(6000, findTimeoutMs));
    }
    if (!found.strategy) {
      if (found.already) {
        log(`no composer; already messaged ("${found.already}")`);
        return fail(ALREADY_MESSAGED);
      }
      if (found.unavailable) return { ok: false, message: 'This listing is no longer available.', fallbackToWindow: false };
      log('no composer found');
      return fail(NO_COMPOSER);
    }
    log(`composer found via ${found.strategy}`);

    if (!(await typeMessage(page, page.locator('[data-faceslop-input]').first(), found.rich, text))) {
      log('typing into the composer failed');
      return fail("Couldn't type into Facebook's message box. Open the listing in the Marketplace view instead.");
    }
    const sendLabel = await runInPage(page, markSendButton).catch(() => null);
    if (!sendLabel) {
      log('no send button found');
      return fail("Couldn't find Facebook's Send button. Open the listing in the Marketplace view instead.");
    }
    log(`send button "${sendLabel}"`);

    const probe = probeOf(text);
    const before = await runInPage(page, readSentState, probe);
    graphql.arm();
    try {
      await page.locator('[data-faceslop-send]').first().click({ timeout: 5000 });
    } catch {
      log('clicking send failed');
      return fail("Couldn't press Facebook's Send button, so the message was probably not sent.");
    }
    return await confirmSent(page, graphql.result, before, probe, confirmTimeoutMs, log);
  } finally {
    graphql.dispose();
  }
}

async function confirmSent(
  page: Page,
  graphql: { ok: boolean; error: string | null },
  before: SentState,
  probe: string,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<SendMessageResult> {
  const sent = (how: string): SendMessageResult => {
    log(`confirmed via ${how}`);
    return { ok: true, message: 'Message sent.', fallbackToWindow: false };
  };
  const startUrl = page.url();
  const started = Date.now();
  let goneSince = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(300);
    if (graphql.error) {
      log('send mutation returned an error');
      return fail(`Facebook couldn't send the message (${graphql.error}).`);
    }
    if (graphql.ok) return sent('graphql');

    let state: SentState | null = null;
    try {
      state = await runInPage(page, readSentState, probe);
    } catch {
      // the page is navigating
    }
    if (!state) {
      if (page.url() !== startUrl && /\/messages\/(e2ee\/)?t\//.test(page.url())) return sent('opened conversation');
      continue;
    }
    if (state.errorText && state.errorText !== before.errorText) {
      log('error shown after send');
      return fail(`Facebook couldn't send the message: ${state.errorText}`);
    }
    if (state.sentText && state.sentText !== before.sentText) return sent(`"${state.sentText}"`);
    if (probe && state.echoes > before.echoes && !state.inputHasText) return sent('message shown in conversation');
    if (!state.composerPresent) {
      goneSince ||= Date.now();
      if (Date.now() - goneSince >= 1200) return sent('composer closed');
    } else {
      goneSince = 0;
    }
  }
  log('send not confirmed');
  return fail(UNCONFIRMED);
}
