import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Send, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { ErrorState } from '@/components/error-state';
import { RemoteViewDialogButton } from '@/components/remote-viewer/remote-view-panel';
import { ConnectPrompt } from '@/components/require-facebook';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useSendMessage } from '@/hooks/mutations';
import { authStatusQuery } from '@/lib/queries';
import { MAX_MESSAGE_LENGTH, type ListingDetail } from '@/shared/domain';

const QUICK_REPLIES = ['Is this still available?', 'Is the price negotiable?', 'When could I pick it up?'];

const INBOX_DIALOG = {
  title: 'Marketplace inbox',
  description: 'Your Marketplace conversations, and nothing else from Facebook.',
} as const;

/** Messaging the seller, or the right next step when that isn't possible from here. */
export function MessagePanel({ listing }: { readonly listing: ListingDetail }) {
  const auth = useQuery(authStatusQuery);
  if (auth.isPending) return <Skeleton className="h-48 w-full" />;
  if (auth.data?.state !== 'logged_in') {
    return <ConnectPrompt stacked reason="Messaging a seller needs your Facebook account. Browsing works without it." />;
  }
  if (listing.isViewerSeller) {
    return (
      <PanelCard title="This is your listing" description="Edit it, mark it sold, or renew it on Marketplace.">
        <RemoteViewDialogButton
          request={{ target: 'selling' }}
          title="Your listings"
          description="What you're selling on Marketplace."
        >
          Your listings
        </RemoteViewDialogButton>
      </PanelCard>
    );
  }
  if (listing.hasMessaged) {
    return (
      <PanelCard title="You’ve messaged this seller" description="Replies arrive in your Marketplace inbox.">
        <RemoteViewDialogButton request={{ target: 'inbox' }} {...INBOX_DIALOG}>
          Open Marketplace inbox
        </RemoteViewDialogButton>
      </PanelCard>
    );
  }
  if (!listing.canMessage) {
    return (
      <PanelCard title="Message the seller" description="Facebook doesn’t allow messaging this listing from here.">
        <ListingDialogButton listing={listing} />
      </PanelCard>
    );
  }
  return <MessageComposer listing={listing} />;
}

function PanelCard({ title, description, children }: { readonly title: string; readonly description: string; readonly children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ListingDialogButton({ listing }: { readonly listing: ListingDetail }) {
  return (
    <RemoteViewDialogButton
      request={{ target: 'listing', listingId: listing.id }}
      title={listing.title}
      description="This listing on Marketplace, where you can message the seller directly."
    >
      Open the listing on Marketplace
    </RemoteViewDialogButton>
  );
}

function MessageComposer({ listing }: { readonly listing: ListingDetail }) {
  const id = useId();
  const [text, setText] = useState('');
  const send = useSendMessage(listing.id);
  const result = send.data;
  const sellerName = listing.seller?.name ?? listing.sellerName ?? 'the seller';

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const message = text.trim();
    if (message !== '') send.mutate(message);
  };

  if (result?.ok === true) {
    return (
      <PanelCard title="Message sent" description="The seller’s reply will arrive in your Marketplace inbox.">
        <Alert role="status">
          <CircleCheck aria-hidden="true" className="text-success" />
          <AlertTitle>{result.message}</AlertTitle>
        </Alert>
        <RemoteViewDialogButton request={{ target: 'inbox' }} {...INBOX_DIALOG}>
          Open Marketplace inbox
        </RemoteViewDialogButton>
      </PanelCard>
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Message {sellerName}</h2>
        </CardTitle>
        <CardDescription>Sent from your Facebook account. Replies arrive in your Marketplace inbox.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div role="group" aria-label="Quick replies" className="flex flex-wrap gap-1.5">
            {QUICK_REPLIES.map((reply) => (
              <Button
                key={reply}
                variant={text === reply ? 'secondary' : 'outline'}
                size="xs"
                aria-pressed={text === reply}
                onPress={() => {
                  setText(reply);
                }}
              >
                {reply}
              </Button>
            ))}
          </div>
          <Field>
            <FieldLabel htmlFor={`${id}-message`} className="sr-only">
              Message
            </FieldLabel>
            <Textarea
              id={`${id}-message`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
              }}
              rows={3}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder="Write a message"
            />
            {text.length > MAX_MESSAGE_LENGTH - 100 && (
              <FieldDescription>
                {MAX_MESSAGE_LENGTH - text.length} characters left
              </FieldDescription>
            )}
          </Field>
          {result !== undefined && (
            <Alert>
              <TriangleAlert aria-hidden="true" className="text-warning" />
              <AlertTitle>Not sent</AlertTitle>
              <AlertDescription>
                <p>{result.message}</p>
                {result.fallbackToWindow && (
                  <div className="mt-3">
                    <ListingDialogButton listing={listing} />
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
          {send.isError && <ErrorState error={send.error} />}
          <Button type="submit" isPending={send.isPending} isDisabled={text.trim() === ''} className="self-end">
            <Send aria-hidden="true" />
            Send
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
