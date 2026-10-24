import { useQuery } from '@tanstack/react-query';
import { Outlet, createFileRoute } from '@tanstack/react-router';
import { NudgeBanner } from '@/components/nudge-banner';
import { MobileNav, TopBar } from '@/components/top-bar';
import { useSavedSearchNotifier } from '@/hooks/use-saved-search-notifier';
import { useSessionNudge } from '@/hooks/use-session-nudge';
import { authStatusQuery, settingsQuery, settled } from '@/lib/queries';

/** Layout for every page except "closed for now": top bar, browsing nudge, phone nav. */
export const Route = createFileRoute('/_app')({
  loader: ({ context: { queryClient } }) =>
    settled(queryClient.query({ ...settingsQuery, staleTime: 'static' }), queryClient.query({ ...authStatusQuery, staleTime: 'static' })),
  component: AppShell,
});

function AppShell() {
  const { data: settings } = useQuery(settingsQuery);
  const nudge = useSessionNudge(settings?.sessionNudgeMinutes ?? 0);
  useSavedSearchNotifier(settings?.desktopNotifications ?? false);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-4 py-2 text-sm shadow-md focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <TopBar />
      {nudge.show && <NudgeBanner nudge={nudge} />}
      <main id="main" className="flex-1 pb-24 md:pb-16">
        <Outlet />
      </main>
      <MobileNav />
    </div>
  );
}
