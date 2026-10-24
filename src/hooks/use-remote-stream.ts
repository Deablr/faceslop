// Subscribes to the remote view's event stream while the calling component is mounted.
import { useEffect, useEffectEvent, useState } from 'react';
import { connectRemoteStream, type StreamStatus } from '@/lib/remote-stream';
import type { RemoteStreamEvent } from '@/shared/remote-view';

export type { StreamStatus } from '@/lib/remote-stream';

export function useRemoteStream(onEvent: (event: RemoteStreamEvent) => void, onRefused: () => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handleEvent = useEffectEvent(onEvent);
  const handleRefused = useEffectEvent(onRefused);

  useEffect(
    () =>
      connectRemoteStream({
        onEvent: (event) => {
          handleEvent(event);
        },
        onStatus: setStatus,
        onRefused: () => {
          handleRefused();
        },
      }),
    [],
  );

  return status;
}
