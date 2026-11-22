// Settings → Webhooks: where group watch matches go. Each webhook gets signed JSON POSTs
// (src/server/webhooks/Webhooks.ts); this lists them with their last delivery, and lets the user
// add, test, pause, re-key and delete them.
import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';
import { ErrorState, InlineError } from '@/components/error-state';
import { RelativeTime } from '@/components/listing-bits';
import { ConnectPrompt } from '@/components/require-facebook';
import { SettingsSection } from '@/components/settings/settings-section';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useCreateWebhook, useDeleteWebhook, useTestWebhook, useUpdateWebhook } from '@/hooks/mutations';
import { authStatusQuery, webhookDeliveriesQuery, webhooksQuery } from '@/lib/queries';
import type { Webhook, WebhookDelivery } from '@/shared/domain';

export function WebhooksSection() {
  const auth = useQuery(authStatusQuery);
  return (
    <SettingsSection
      id="webhooks"
      title="Webhooks"
      description="New posts that match a group watch are sent to every webhook here as signed JSON. They belong to your Facebook account."
    >
      {auth.data?.state === 'logged_in' ? (
        <div className="flex flex-col gap-6">
          <WebhookList />
          <AddWebhookForm />
          <SigningHelp />
        </div>
      ) : (
        <ConnectPrompt reason="Webhooks go with group watches, which need your Facebook account." stacked />
      )}
    </SettingsSection>
  );
}

function WebhookList() {
  const webhooks = useQuery(webhooksQuery);
  if (webhooks.isPending) return <Skeleton className="h-16 w-full" />;
  if (webhooks.isError) {
    return (
      <ErrorState
        error={webhooks.error}
        onRetry={() => {
          void webhooks.refetch();
        }}
      />
    );
  }
  if (webhooks.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No webhooks yet. Add one below, then “Send test” to check it.</p>;
  }
  return (
    <ItemGroup>
      {webhooks.data.map((w) => (
        <WebhookRow key={w.id} webhook={w} />
      ))}
    </ItemGroup>
  );
}

const STATUS_LABEL: Readonly<Record<WebhookDelivery['status'], string>> = {
  pending: 'Retrying',
  delivered: 'Delivered',
  failed: 'Failed',
};

function DeliveryStatus({ delivery }: { readonly delivery: WebhookDelivery }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={delivery.status === 'failed' ? 'destructive' : delivery.status === 'pending' ? 'outline' : 'secondary'}>
        {STATUS_LABEL[delivery.status]}
      </Badge>
      <span>
        {delivery.summary} · <RelativeTime ms={delivery.lastAttemptAt ?? delivery.createdAt} />
        {delivery.error !== null && delivery.status !== 'delivered' && ` · ${delivery.error}`}
      </span>
    </span>
  );
}

function WebhookRow({ webhook }: { readonly webhook: Webhook }) {
  const id = useId();
  const [showSecret, setShowSecret] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const update = useUpdateWebhook();
  const remove = useDeleteWebhook();
  const test = useTestWebhook();

  let testStatus = '';
  if (test.isPending) testStatus = 'Sending…';
  else if (test.isSuccess) {
    testStatus = test.data.ok
      ? `Test delivered (HTTP ${String(test.data.httpStatus)})`
      : `Test failed: ${test.data.error ?? `HTTP ${String(test.data.httpStatus)}`}`;
  }

  return (
    <Item variant="outline">
      <ItemContent className="min-w-56">
        <ItemTitle>{webhook.name}</ItemTitle>
        <ItemDescription>
          <span className="font-mono text-xs break-all">{webhook.url}</span>
        </ItemDescription>
        <div className="text-xs text-muted-foreground">
          {webhook.lastDelivery === null ? 'Nothing sent yet' : <DeliveryStatus delivery={webhook.lastDelivery} />}
        </div>
        {testStatus !== '' && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {testStatus}
          </p>
        )}
      </ItemContent>
      <ItemActions className="flex-wrap">
        <Button
          variant="outline"
          size="sm"
          isPending={test.isPending}
          onPress={() => {
            test.mutate(webhook.id);
          }}
        >
          Send test
        </Button>
        <div className="flex items-center gap-2 px-2">
          <Switch
            id={`${id}-on`}
            size="sm"
            isSelected={webhook.enabled}
            onChange={(enabled) => {
              update.mutate({ id: webhook.id, patch: { enabled } });
            }}
          />
          <Label htmlFor={`${id}-on`}>On</Label>
        </div>
        <AlertDialogTrigger>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${webhook.name}`}>
            <Trash2 aria-hidden="true" />
          </Button>
          <AlertDialog size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{webhook.name}”?</AlertDialogTitle>
              <AlertDialogDescription>Nothing more is sent to it, and its delivery log is deleted.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <Button
                variant="destructive"
                slot="close"
                onPress={() => {
                  remove.mutate(webhook.id);
                }}
              >
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialog>
        </AlertDialogTrigger>
      </ItemActions>
      <div className="flex basis-full flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showSecret}
            onPress={() => {
              setShowSecret((v) => !v);
            }}
          >
            {showSecret ? 'Hide signing secret' : 'Signing secret'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showLog}
            onPress={() => {
              setShowLog((v) => !v);
            }}
          >
            {showLog ? 'Hide deliveries' : 'Deliveries'}
          </Button>
        </div>
        {showSecret && (
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{webhook.secret}</code>
            <Button
              variant="outline"
              size="sm"
              isPending={update.isPending && update.variables.patch.rotateSecret === true}
              onPress={() => {
                update.mutate({ id: webhook.id, patch: { rotateSecret: true } });
              }}
            >
              New secret
            </Button>
          </div>
        )}
        {showLog && <DeliveryLog webhookId={webhook.id} />}
        <InlineError error={update.error ?? remove.error ?? test.error} />
      </div>
    </Item>
  );
}

function DeliveryLog({ webhookId }: { readonly webhookId: number }) {
  const deliveries = useQuery(webhookDeliveriesQuery(webhookId));
  if (deliveries.isPending) return <Skeleton className="h-12 w-full" />;
  if (deliveries.isError) {
    return (
      <ErrorState
        error={deliveries.error}
        onRetry={() => {
          void deliveries.refetch();
        }}
      />
    );
  }
  if (deliveries.data.length === 0) return <p className="text-xs text-muted-foreground">Nothing sent yet.</p>;
  return (
    <ul aria-label="Recent deliveries" className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      {deliveries.data.map((d) => (
        <li key={d.id}>
          <DeliveryStatus delivery={d} />
        </li>
      ))}
    </ul>
  );
}

function AddWebhookForm() {
  const id = useId();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const create = useCreateWebhook();

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    create.mutate(
      { name: name.trim() || 'Webhook', url: url.trim() },
      {
        onSuccess: () => {
          setName('');
          setUrl('');
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            placeholder="Phone"
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor={`${id}-url`}>URL</Label>
          <Input
            id={`${id}-url`}
            value={url}
            inputMode="url"
            autoComplete="off"
            placeholder="https://example.com/hooks/puppies"
            onChange={(e) => {
              setUrl(e.target.value);
            }}
          />
        </div>
      </div>
      <div>
        <Button type="submit" isPending={create.isPending} isDisabled={url.trim() === ''}>
          Add webhook
        </Button>
      </div>
      <InlineError error={create.error} />
    </form>
  );
}

const VERIFY_EXAMPLE = `// Node: verify a faceslop webhook
const expected = 'sha256=' + crypto
  .createHmac('sha256', SECRET)
  .update(req.headers['x-faceslop-timestamp'] + '.' + rawBody)
  .digest('hex');
const ok = crypto.timingSafeEqual(
  Buffer.from(expected), Buffer.from(req.headers['x-faceslop-signature']));`;

function SigningHelp() {
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="cursor-default font-medium text-foreground">What gets sent</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p>
          A <code className="font-mono text-xs">POST</code> with a JSON body for each matching post:{' '}
          <code className="font-mono text-xs">event</code> (“group.post”), the watch (group, matched keywords) and the post
          (link, text, author, time, photo links). Answer with any 2xx. Failures are retried for about 8 hours; redirects
          aren’t followed.
        </p>
        <p>
          Headers: <code className="font-mono text-xs">X-Faceslop-Event</code>,{' '}
          <code className="font-mono text-xs">X-Faceslop-Delivery</code> (the same on retries),{' '}
          <code className="font-mono text-xs">X-Faceslop-Timestamp</code> and{' '}
          <code className="font-mono text-xs">X-Faceslop-Signature</code>, an HMAC-SHA256 of “timestamp.body” with the
          webhook’s signing secret.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">{VERIFY_EXAMPLE}</pre>
      </div>
    </details>
  );
}
