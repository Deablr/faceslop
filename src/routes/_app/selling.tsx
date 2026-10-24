import { createFileRoute } from '@tanstack/react-router';
import { CirclePlus, Package } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { RemoteViewPanel, type RemoteChoice } from '@/components/remote-viewer/remote-view-panel';
import { RequireFacebook } from '@/components/require-facebook';
import { remoteViewStateQuery, settled } from '@/lib/queries';

const CHOICES: readonly RemoteChoice[] = [
  {
    request: { target: 'create' },
    title: 'Create a listing',
    description: 'Photos, price and description, then publish.',
    action: 'Create a listing',
    icon: CirclePlus,
  },
  {
    request: { target: 'selling' },
    title: 'Your listings',
    description: 'Edit, mark as sold, or renew what you’re selling.',
    action: 'Your listings',
    icon: Package,
  },
];

export const Route = createFileRoute('/_app/selling')({
  loader: ({ context: { queryClient } }) => settled(queryClient.query({ ...remoteViewStateQuery, staleTime: 'static' })),
  head: () => ({ meta: [{ title: 'Selling · faceslop' }] }),
  component: SellingPage,
});

function SellingPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader title="Selling">
        Listing and managing items happens on Marketplace’s own pages, shown here so nothing else on Facebook gets in
        the way.
      </PageHeader>
      <RequireFacebook reason="Selling uses your Facebook account.">
        <RemoteViewPanel choices={CHOICES} />
      </RequireFacebook>
    </div>
  );
}
