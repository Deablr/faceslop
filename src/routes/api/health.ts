import { createFileRoute } from '@tanstack/react-router';
import { OK } from '@/shared/domain';

/** Liveness probe (Docker healthcheck). Always reachable; touches no services. */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => Response.json(OK, { headers: { 'cache-control': 'no-store' } }),
    },
  },
});
