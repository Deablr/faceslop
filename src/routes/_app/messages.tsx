import { createFileRoute } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { RemoteViewPanel, type RemoteChoice } from '@/components/remote-viewer/remote-view-panel';
import { RequireFacebook } from '@/components/require-facebook';
import { remoteViewStateQuery, settled } from '@/lib/queries';

const CHOICES: readonly RemoteChoice[] = [
  {
    request: { target: 'inbox' },
    title: 'Your Marketplace inbox',
    description: 'Buying and selling conversations, and nothing else from Facebook.',
    action: 'Open inbox',
    icon: Inbox,
  },
];

export const Route = createFileRoute('/_app/messages')({
  loader: ({ context: { queryClient } }) => settled(queryClient.query({ ...remoteViewStateQuery, staleTime: 'static' })),
  head: () => ({ meta: [{ title: 'Messages · faceslop' }] }),
  component: MessagesPage,
});

function MessagesPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader title="Messages">
        Marketplace chats open right here, locked to Marketplace: no feed, no reels, no notifications from the rest of
        Facebook. Press Done when you’re finished.
      </PageHeader>
      <RequireFacebook reason="Your Marketplace inbox lives in your Facebook account.">
        <RemoteViewPanel choices={CHOICES} />
      </RequireFacebook>
    </div>
  );
}
