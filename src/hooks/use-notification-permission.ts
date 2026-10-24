// The browser's notification permission as React state. Null during SSR and hydration (the server
// can't know it), so what the server rendered always matches the first client render; right after
// hydration React re-renders with the real value.
import { useSyncExternalStore } from 'react';
import { notificationSupport, type NotificationSupport } from '@/lib/notifications';

function subscribe(onChange: () => void): () => void {
  // The permission can change in the browser's site settings while the tab is open.
  let status: PermissionStatus | null = null;
  let active = true;
  if ('permissions' in navigator) {
    navigator.permissions.query({ name: 'notifications' }).then(
      (result) => {
        if (!active) return;
        status = result;
        result.addEventListener('change', onChange);
      },
      () => undefined,
    );
  }
  window.addEventListener('focus', onChange);
  return () => {
    active = false;
    status?.removeEventListener('change', onChange);
    window.removeEventListener('focus', onChange);
  };
}

const unknown = (): null => null;

/** 'granted' | 'denied' | 'default' | 'unsupported', or null while not known yet (SSR, hydration). */
export function useNotificationPermission(): NotificationSupport | null {
  return useSyncExternalStore(subscribe, notificationSupport, unknown);
}
