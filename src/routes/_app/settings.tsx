import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ErrorState } from '@/components/error-state';
import { LocalDataNote } from '@/components/local-data-note';
import { AppLockSection, FacebookAccountSection } from '@/components/settings/account-sections';
import { BlockedSellersSection, HiddenListingsSection } from '@/components/settings/list-sections';
import { PreferenceSections } from '@/components/settings/preference-sections';
import { Skeleton } from '@/components/ui/skeleton';
import { useUpdateSettings } from '@/hooks/mutations';
import { blockedSellersQuery, hiddenQuery, settingsQuery, settled } from '@/lib/queries';
import { toClientError } from '@/shared/errors';

export const Route = createFileRoute('/_app/settings')({
  loader: ({ context: { queryClient } }) =>
    settled(queryClient.query({ ...blockedSellersQuery, staleTime: 'static' }), queryClient.query({ ...hiddenQuery, staleTime: 'static' })),
  head: () => ({ meta: [{ title: 'Settings · faceslop' }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const settings = useQuery(settingsQuery);
  const update = useUpdateSettings();

  let saveStatus = '';
  if (update.isPending) saveStatus = 'Saving…';
  else if (update.isError) saveStatus = `Not saved: ${toClientError(update.error).message}`;
  else if (update.isSuccess) saveStatus = 'Saved';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {saveStatus}
          </p>
        </div>
        <LocalDataNote what="Your settings, blocked sellers and hidden listings" />
      </div>
      {settings.isPending ? (
        <div className="flex flex-col gap-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : settings.isError ? (
        <ErrorState
          error={settings.error}
          onRetry={() => {
            void settings.refetch();
          }}
          retrying={settings.isFetching}
        />
      ) : (
        <PreferenceSections
          settings={settings.data}
          onChange={(patch) => {
            update.mutate(patch);
          }}
        />
      )}
      <BlockedSellersSection />
      <HiddenListingsSection />
      <FacebookAccountSection />
      <AppLockSection />
    </div>
  );
}
