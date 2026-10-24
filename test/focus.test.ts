// The remote view's Marketplace-only allowlist and where each target opens.
// Port of legacy/test/focus.test.ts (focusUrl is now remoteTargetUrl).
import { describe, expect, it } from 'vitest';
import { FOCUS_HOME, isAllowedFocusedUrl } from '@/server/remote-view/focus-guards';
import { LOGIN_URL, REMOTE_TARGETS, remoteTargetUrl } from '@/server/remote-view/targets';
import { RemoteTarget } from '@/shared/remote-view';

describe('isAllowedFocusedUrl', () => {
  const allowed = [
    'https://www.facebook.com/marketplace',
    'https://www.facebook.com/marketplace/',
    'https://www.facebook.com/marketplace/?ref=bookmark',
    'https://www.facebook.com/marketplace/nyc/',
    'https://www.facebook.com/marketplace/nyc/search/?query=desk',
    'https://www.facebook.com/marketplace/category/bicycles',
    'https://www.facebook.com/marketplace/item/2461492287676369/',
    'https://www.facebook.com/marketplace/item/2461492287676369/?ref=search&referral_code=null',
    'https://www.facebook.com/marketplace/inbox/',
    'https://www.facebook.com/marketplace/you/selling/',
    'https://www.facebook.com/marketplace/you/buying/',
    'https://www.facebook.com/marketplace/create/item/',
    'https://www.facebook.com/marketplace/create/vehicle/',
    'https://www.facebook.com/marketplace/profile/100012345678/',
    'https://www.facebook.com/MARKETPLACE/Item/123/',
    'https://facebook.com/marketplace/',
    'https://web.facebook.com/marketplace/',
    'https://m.facebook.com/marketplace/item/123/',
    'http://www.facebook.com/marketplace/',
    'https://www.facebook.com/messages/t/1234567890/',
    'https://www.facebook.com/messages/t/1234567890',
    'https://www.facebook.com/messages/e2ee/t/9876543210/',
    // staying logged in
    'https://www.facebook.com/login/',
    'https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fmarketplace%2F',
    'https://www.facebook.com/login.php?login_attempt=1',
    'https://www.facebook.com/login/device-based/regular/login/?login_attempt=1',
    'https://www.facebook.com/login/identify/?ctx=recover',
    'https://www.facebook.com/checkpoint/?next',
    'https://www.facebook.com/checkpoint/1501092823525282/',
    'https://www.facebook.com/two_step_verification/two_factor/?encrypted_context=abc',
    'https://www.facebook.com/two_factor/',
    'https://www.facebook.com/auth_platform/afad/?apc=abc',
    'https://www.facebook.com/recover/initiate/',
    'https://www.facebook.com/privacy/consent/user_cookie_choice/',
    'https://www.facebook.com/logout.php',
  ];

  const blocked = [
    // the feed and other engagement surfaces
    'https://www.facebook.com/',
    'https://www.facebook.com',
    'https://www.facebook.com/?sk=h_chr',
    'https://www.facebook.com/home.php',
    'https://www.facebook.com/watch',
    'https://www.facebook.com/watch/?v=123',
    'https://www.facebook.com/reel/123456/',
    'https://www.facebook.com/reels/',
    'https://www.facebook.com/stories/123/',
    'https://www.facebook.com/notifications',
    'https://www.facebook.com/groups/feed/',
    'https://www.facebook.com/groups/123/',
    'https://www.facebook.com/friends',
    'https://www.facebook.com/gaming/',
    'https://www.facebook.com/events/',
    'https://www.facebook.com/memories/',
    'https://www.facebook.com/saved/',
    'https://www.facebook.com/search/top/?q=desk',
    // profiles and pages
    'https://www.facebook.com/zuck',
    'https://www.facebook.com/profile.php?id=4',
    'https://www.facebook.com/people/Jane-Doe/100012345678/',
    // Messenger beyond a single thread
    'https://www.facebook.com/messages/',
    'https://www.facebook.com/messages/t/',
    'https://www.facebook.com/messages/e2ee/t/',
    'https://www.messenger.com/t/123',
    // link shims and other sites
    'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com',
    'https://lm.facebook.com/l.php?u=https%3A%2F%2Fexample.com',
    'https://www.facebook.com/l.php?u=https%3A%2F%2Fexample.com',
    'https://example.com/marketplace/',
    'https://www.facebook.com.evil.com/marketplace/',
    'https://evilfacebook.com/marketplace/',
    'https://business.facebook.com/marketplace/',
    'https://www.instagram.com/',
    // look-alike paths
    'https://www.facebook.com/marketplacefoo',
    'https://www.facebook.com/marketplace/../watch',
    'https://www.facebook.com/marketplace/%2e%2e/watch',
    'https://www.facebook.com//watch',
    'https://www.facebook.com/loginfoo',
    'https://www.facebook.com/r.php',
    'https://www.facebook.com/settings',
    // not web pages
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'not a url',
    '',
  ];

  it.each(allowed)('allows %s', (url) => {
    expect(isAllowedFocusedUrl(url)).toBe(true);
  });
  it.each(blocked)('blocks %s', (url) => {
    expect(isAllowedFocusedUrl(url)).toBe(false);
  });
});

describe('remoteTargetUrl', () => {
  it('maps targets to Marketplace pages (and the login page)', () => {
    expect(remoteTargetUrl('inbox')).toBe('https://www.facebook.com/marketplace/inbox/');
    expect(remoteTargetUrl('selling')).toBe('https://www.facebook.com/marketplace/you/selling/');
    expect(remoteTargetUrl('create')).toBe('https://www.facebook.com/marketplace/create/item/');
    expect(remoteTargetUrl('listing', '2461492287676369')).toBe('https://www.facebook.com/marketplace/item/2461492287676369/');
    expect(remoteTargetUrl('login')).toBe(LOGIN_URL);
    expect(LOGIN_URL).toBe('https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fmarketplace%2F');
  });

  it('every target URL passes the guard, and so does the guard home', () => {
    for (const target of RemoteTarget.literals) {
      const url = remoteTargetUrl(target, '1');
      expect(url, target).not.toBeNull();
      expect(isAllowedFocusedUrl(url ?? ''), target).toBe(true);
    }
    expect(isAllowedFocusedUrl(FOCUS_HOME)).toBe(true);
  });

  it('rejects listing targets without a usable id', () => {
    expect(remoteTargetUrl('listing')).toBeNull();
    expect(remoteTargetUrl('listing', '../watch')).toBeNull();
    expect(remoteTargetUrl('listing', '12a')).toBeNull();
    // Facebook loops on ids longer than 20 digits.
    expect(remoteTargetUrl('listing', '1'.repeat(21))).toBeNull();
    expect(remoteTargetUrl('listing', ' 123 ')).toBe('https://www.facebook.com/marketplace/item/123/');
  });

  it('only Marketplace pages that are useless logged out need a session', () => {
    expect(Object.entries(REMOTE_TARGETS).filter(([, info]) => info.needsLogin).map(([target]) => target)).toEqual([
      'inbox',
      'selling',
      'create',
    ]);
  });
});
