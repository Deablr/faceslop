// Human titles and next steps for error codes (the message itself always comes from the server).
import type { ClientErrorCode } from '@/shared/errors';

const TITLES: Partial<Record<ClientErrorCode, string>> = {
  NETWORK: "Can't reach faceslop",
  FB_BLOCKED: 'Facebook stopped this request',
  FB_TIMEOUT: 'Facebook took too long',
  FB_PARSE_FAILED: "Couldn't read Facebook's page",
  NOT_LOGGED_IN: 'Connect Facebook first',
  NOT_FOUND: 'Not found',
  SESSION_EXPIRED: 'These results expired',
  FORBIDDEN: 'Not allowed',
  APP_LOCKED: 'faceslop is locked',
  BAD_REQUEST: "That didn't look right",
};

export function errorTitle(code: ClientErrorCode): string {
  return TITLES[code] ?? 'Something went wrong';
}

/** Codes where reconnecting Facebook is the most useful next step. */
export function suggestsReconnect(code: ClientErrorCode): boolean {
  return code === 'FB_BLOCKED' || code === 'NOT_LOGGED_IN';
}
