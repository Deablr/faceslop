// Client side of GET /api/remote/stream (protocol: src/shared/remote-view.ts), framework-free.
// EventSource retries dropped connections by itself; when the server refuses the stream outright
// (an error status, e.g. while the app is locked) it gives up, so we retry with backoff and tell
// the caller (who re-checks the view state).
import {
  REMOTE_STREAM_EVENT_NAMES,
  REMOTE_STREAM_PATH,
  decodeRemoteSseMessage,
  type RemoteStreamEvent,
} from '@/shared/remote-view';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

export interface RemoteStreamHandlers {
  readonly onEvent: (event: RemoteStreamEvent) => void;
  readonly onStatus: (status: StreamStatus) => void;
  /** The server refused the stream (not a dropped connection). */
  readonly onRefused: () => void;
}

const MAX_BACKOFF_MS = 15_000;

/** Opens the stream; returns a function that closes it for good. */
export function connectRemoteStream(handlers: RemoteStreamHandlers): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const onMessage = (name: string) => (message: MessageEvent<unknown>) => {
    const event = typeof message.data === 'string' ? decodeRemoteSseMessage(name, message.data) : null;
    if (event !== null) handlers.onEvent(event);
  };

  const connect = () => {
    if (closed) return;
    const stream = new EventSource(REMOTE_STREAM_PATH);
    source = stream;
    stream.onopen = () => {
      attempt = 0;
      handlers.onStatus('live');
    };
    for (const name of REMOTE_STREAM_EVENT_NAMES) stream.addEventListener(name, onMessage(name));
    stream.onerror = () => {
      handlers.onStatus('reconnecting');
      // CONNECTING: the browser is already retrying. CLOSED: it gave up (an error response).
      if (stream.readyState !== EventSource.CLOSED) return;
      stream.close();
      handlers.onRefused();
      retryTimer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt));
      attempt += 1;
    };
  };

  connect();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    source?.close();
  };
}
