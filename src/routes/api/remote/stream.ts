import { createFileRoute } from '@tanstack/react-router';
import { remoteStreamHandler } from '@/server/remote-view/stream-handler';

/** The caller's own remote view (frames/state) as Server-Sent Events (protocol: src/shared/remote-view.ts). */
export const Route = createFileRoute('/api/remote/stream')({
  server: {
    handlers: {
      GET: remoteStreamHandler,
    },
  },
});
