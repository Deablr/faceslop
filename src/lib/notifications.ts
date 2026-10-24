// Desktop notifications (opt-in, Settings > Wellbeing). Browser-only helpers; safe to call during
// SSR (they report "unsupported").

export type NotificationSupport = 'unsupported' | NotificationPermission;

export function notificationSupport(): NotificationSupport {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/** Ask for permission (only from a user action). Resolves to the resulting permission. */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  const support = notificationSupport();
  if (support === 'unsupported' || support === 'granted') return support;
  return Notification.requestPermission();
}
