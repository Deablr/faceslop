// sendViaComposer against local fixtures that mimic Facebook's logged-in listing page, in a
// HEADLESS browser. Every request is answered locally; nothing reaches facebook.com.
// Port of legacy/test/messaging-composer.test.ts. FACESLOP_SKIP_BROWSER_TESTS=1 skips the browser part.
import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ALREADY_MESSAGED,
  type ComposerOptions,
  friendlyName,
  graphqlOutcome,
  isSendMutationName,
  sendViaComposer,
} from '@/server/messaging/composer';

const skip = process.env.FACESLOP_SKIP_BROWSER_TESTS === '1';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const LISTING_URL = 'https://www.facebook.com/marketplace/item/1234567890/';
const MESSAGE = 'Hi! Is the desk still available? I could pick it up Saturday morning.';

let browser: Browser;
let context: BrowserContext | null = null;
beforeAll(async () => {
  if (!skip) browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  if (!skip) await browser.close();
});
afterEach(async () => {
  await context?.close();
  context = null;
});

interface Opened {
  page: Page;
  graphqlNames: string[];
  logs: string[];
  opts: ComposerOptions;
}

/** Serve a fixture as the listing page; GraphQL answers with `graphqlBody`. */
async function open(fixture: string, graphqlBody = '{"data":{"marketplace_send_message":{"id":"m1"}}}'): Promise<Opened> {
  const opened = await browser.newContext();
  context = opened;
  const graphqlNames: string[] = [];
  await opened.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== 'www.facebook.com') return route.abort();
    if (url.pathname === '/api/graphql/') {
      graphqlNames.push(friendlyName(request.headers(), request.postData()) ?? '?');
      return route.fulfill({ contentType: 'application/json', body: graphqlBody });
    }
    if (url.pathname === new URL(LISTING_URL).pathname) {
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(FIXTURES, fixture), 'utf8') });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await opened.newPage();
  await page.goto(LISTING_URL);
  const logs: string[] = [];
  const log = (line: string) => {
    logs.push(line);
  };
  return { page, graphqlNames, logs, opts: { findTimeoutMs: 2000, confirmTimeoutMs: 4000, log } };
}

/** A value the fixture page keeps on `window` (e.g. `__sent`, `__sendClicks`). */
const getGlobal = <T>(page: Page, name: string): Promise<T> =>
  page.evaluate((n) => (window as unknown as Record<string, unknown>)[n], name) as Promise<T>;

/** The fixtures read `window.__mode` to decide how their fake Send behaves. */
const setMode = (page: Page, mode: string) =>
  page.evaluate((m) => {
    (window as unknown as { __mode: string }).__mode = m;
  }, mode);

describe.skipIf(skip)('sendViaComposer', () => {
  it('sends through the inline "Send seller a message" box and confirms via GraphQL', async () => {
    const { page, graphqlNames, logs, opts } = await open('messaging-composer.html');
    const result = await sendViaComposer(page, MESSAGE, opts);

    expect(result).toEqual({ ok: true, message: 'Message sent.', fallbackToWindow: false });
    expect(await getGlobal<string[]>(page, '__sent')).toEqual([MESSAGE]); // replaced the prefilled text
    expect(await getGlobal<number>(page, '__sendClicks')).toBe(1);
    expect(await getGlobal<number>(page, '__hiddenSendClicks')).toBe(0); // ignored the hidden duplicate
    expect(graphqlNames).toEqual(['useMarketplaceSendMessageMutation']);
    expect(logs).toContain('composer found via heading');
    expect(logs).toContain('confirmed via graphql');
    // The message text never reaches the log.
    expect(logs.join('\n')).not.toContain('desk');
  });

  it('confirms from the page when there is no GraphQL signal', async () => {
    const { page, logs, opts } = await open('messaging-composer.html');
    await setMode(page, 'dom');
    const result = await sendViaComposer(page, MESSAGE, opts);
    expect(result.ok).toBe(true);
    expect(logs).toContain('confirmed via "Message sent"');
  });

  it('reports a GraphQL error and does not retry', async () => {
    const errorBody = 'for (;;);{"errors":[{"message":"rate limited","description":"You can\'t send messages right now.","severity":"CRITICAL"}],"data":null}';
    const { page, opts } = await open('messaging-composer.html', errorBody);
    await setMode(page, 'gql-error');
    const result = await sendViaComposer(page, MESSAGE, opts);
    expect(result).toEqual({
      ok: false,
      message: "Facebook couldn't send the message (You can't send messages right now.).",
      fallbackToWindow: true,
    });
    expect(await getGlobal<number>(page, '__sendClicks')).toBe(1);
  });

  it('reports an error Facebook shows after sending', async () => {
    const { page, opts } = await open('messaging-composer.html');
    await setMode(page, 'error');
    const result = await sendViaComposer(page, MESSAGE, opts);
    expect(result.ok).toBe(false);
    expect(result.fallbackToWindow).toBe(true);
    expect(result.message).toContain("Couldn't send message");
    expect(await getGlobal<number>(page, '__sendClicks')).toBe(1);
  });

  it('never presses Send twice when nothing confirms the send', async () => {
    const { page, logs, opts } = await open('messaging-composer.html');
    await setMode(page, 'silent');
    const result = await sendViaComposer(page, MESSAGE, { ...opts, confirmTimeoutMs: 1500 });
    expect(result.ok).toBe(false);
    expect(result.fallbackToWindow).toBe(true);
    expect(result.message).toMatch(/didn't confirm/);
    expect(await getGlobal<number>(page, '__sendClicks')).toBe(1);
    expect(logs).toContain('send not confirmed');
  });

  it('handles a rich-text composer found by its label; the composer closing confirms the send', async () => {
    const { page, logs, opts } = await open('messaging-rich.html');
    const text = 'Would you take $250?\nI can pay cash.';
    const result = await sendViaComposer(page, text, opts);
    expect(result.ok).toBe(true);
    expect((await getGlobal<string[]>(page, '__sent')).map((t) => t.replace(/\s+/g, ' '))).toEqual(['Would you take $250? I can pay cash.']);
    expect(await getGlobal<number>(page, '__sendClicks')).toBe(1);
    expect(logs).toContain('composer found via label');
    expect(logs).toContain('send button "Send message"');
    expect(logs).toContain('confirmed via composer closed');
  });

  it('opens the composer from the "Message" button, ignoring an unrelated open chat', async () => {
    const { page, logs, opts } = await open('messaging-dialog.html');
    const result = await sendViaComposer(page, MESSAGE, opts);
    expect(result.ok).toBe(true);
    expect(await getGlobal<string[]>(page, '__sent')).toEqual([MESSAGE]);
    expect(await getGlobal<string[]>(page, '__chatSent')).toEqual([]);
    expect((await page.locator('[aria-label="Chat with Bob"] [role="textbox"]').innerText()).trim()).toBe('');
    expect(logs).toContain('composer found via message-button+prefill');
  });

  it('gives up (without typing anywhere) when the "Message" button opens something else', async () => {
    const { page, opts } = await open('messaging-dialog.html');
    await setMode(page, 'login');
    const result = await sendViaComposer(page, MESSAGE, opts);
    expect(result.ok).toBe(false);
    expect(result.fallbackToWindow).toBe(true);
    expect(result.message).toMatch(/Couldn't find Facebook's message box/);
    expect(await page.locator('input[name="email"]').inputValue()).toBe('');
    expect(await getGlobal<string[]>(page, '__chatSent')).toEqual([]);
  });

  it('falls back to the window when the seller was already messaged', async () => {
    const { page, opts } = await open('messaging-already.html');
    const result = await sendViaComposer(page, MESSAGE, opts);
    expect(result).toEqual({ ok: false, message: ALREADY_MESSAGED, fallbackToWindow: true });
    expect(await getGlobal<number>(page, '__clicks')).toBe(0);
  });

  it('says so when the listing is gone (setContent page)', async () => {
    const opened = await browser.newContext();
    context = opened;
    const page = await opened.newPage();
    await page.setContent('<div role="main"><h1>This listing is no longer available</h1><a href="/marketplace/">Browse Marketplace</a></div>');
    const result = await sendViaComposer(page, MESSAGE, { findTimeoutMs: 1000, log: () => undefined });
    expect(result).toEqual({ ok: false, message: 'This listing is no longer available.', fallbackToWindow: false });
  });

  it('falls back when there is no composer at all (setContent page)', async () => {
    const opened = await browser.newContext();
    context = opened;
    const page = await opened.newPage();
    await page.setContent('<div role="main"><h1>Some listing</h1><p>No way to message here.</p></div>');
    const result = await sendViaComposer(page, MESSAGE, { findTimeoutMs: 800, log: () => undefined });
    expect(result.message).toMatch(/Marketplace view/);
    expect(result.ok).toBe(false);
    expect(result.fallbackToWindow).toBe(true);
  });
});

describe('GraphQL helpers', () => {
  it('reads the operation name from the header or the form body', () => {
    expect(friendlyName({ 'x-fb-friendly-name': 'A' }, 'fb_api_req_friendly_name=B')).toBe('A');
    expect(friendlyName({}, 'av=1&fb_api_req_friendly_name=useMarketplaceSendMessageMutation&variables=%7B%7D')).toBe(
      'useMarketplaceSendMessageMutation',
    );
    expect(friendlyName({}, null)).toBeNull();
  });

  it('recognizes send-message mutations but not chat housekeeping', () => {
    expect(isSendMutationName('useMarketplaceSendMessageMutation')).toBe(true);
    expect(isSendMutationName('MarketplaceContactSellerMutation')).toBe(true);
    expect(isSendMutationName('CometMarketplaceMessageSellerMutation')).toBe(true);
    expect(isSendMutationName('MWChatMessageSeenMutation')).toBe(false);
    expect(isSendMutationName('MessengerTypingIndicatorMutation')).toBe(false);
    expect(isSendMutationName('CometMarketplaceSearchContentPaginationQuery')).toBe(false);
    expect(isSendMutationName('MarketplacePDPContainerQuery')).toBe(false);
  });

  it('classifies response bodies', () => {
    expect(graphqlOutcome('{"data":{"x":1}}')).toEqual({ ok: true, error: null });
    expect(graphqlOutcome('{"data":{"x":1}}\n{"label":"deferred","data":{}}')).toEqual({ ok: true, error: null });
    expect(graphqlOutcome('{"data":{"x":1},"errors":[{"message":"minor","severity":"WARNING"}]}')).toEqual({ ok: true, error: null });
    expect(graphqlOutcome('{"errors":[{"message":"boom"}]}')).toEqual({ ok: false, error: 'boom' });
    expect(graphqlOutcome('for (;;);{"error":1357004,"errorSummary":"Sorry, something went wrong"}')).toEqual({
      ok: false,
      error: 'Sorry, something went wrong',
    });
    expect(graphqlOutcome('{\n  "data": {"x": 1}\n}')).toEqual({ ok: true, error: null });
    expect(graphqlOutcome('<html>')).toEqual({ ok: false, error: null });
    // Unexpected shapes never count as "sent", and never crash.
    expect(graphqlOutcome('null')).toEqual({ ok: false, error: null });
    expect(graphqlOutcome('{"data":{"x":1}}\n42')).toEqual({ ok: false, error: null });
    expect(graphqlOutcome('{"errors":["boom"]}')).toEqual({ ok: false, error: 'Facebook returned an error.' });
    expect(graphqlOutcome('{"errors":[{"message":{"text":"x"},"summary":"Try again"}]}')).toEqual({
      ok: false,
      error: 'Facebook returned an error.',
    });
    expect(graphqlOutcome('{"errors":[{"description":"","summary":"Try again later"}]}')).toEqual({ ok: false, error: 'Try again later' });
  });
});
