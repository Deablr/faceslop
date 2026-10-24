// Server-route handler for GET /api/remote/stream (kept out of the route file so the route module
// itself holds no server-only imports). The bridge reads the caller's session cookie from
// `request` (CurrentClient); the request's abort signal ends the stream when the client
// disconnects. The logic (APP_PASSWORD re-check, the caller's own view only) is in sse.ts.
import '@tanstack/react-start/server-only';
import { runEffectResponse } from '@/server/bridge';
import { remoteStream } from '@/server/remote-view/sse';

export const remoteStreamHandler = ({ request }: { readonly request: Request }): Promise<Response> =>
  runEffectResponse(remoteStream(request.signal), request);
