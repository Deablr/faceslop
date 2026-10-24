// Embeds the remote view on a page: a calm choice of where to go (inbox, your listings, ...), and
// the live viewer once it's open. Each browser has one remote view on the server (its session's);
// opening another target navigates it. The server caps how many views are open across all
// browsers: opening one when it's full shows its message (InlineError).
import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { InlineError } from '@/components/error-state';
import { RemoteViewer } from '@/components/remote-viewer/remote-viewer';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { useCloseRemoteView, useOpenRemoteView } from '@/hooks/mutations';
import { remoteViewStateQuery } from '@/lib/queries';
import { CLOSED_REMOTE_VIEW_STATE, type OpenRemoteViewRequest, type RemoteTarget, type RemoteViewState } from '@/shared/remote-view';

export interface RemoteChoice {
  readonly request: OpenRemoteViewRequest;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly icon: LucideIcon;
}

const TARGET_NAMES: Record<RemoteTarget, string> = {
  login: 'the Facebook login page',
  inbox: 'your Marketplace inbox',
  selling: 'your listings',
  create: 'a new listing',
  listing: 'a listing',
};

/** The server's remote-view state; a failed check counts as closed. */
export function useRemoteViewState(): RemoteViewState {
  const { data } = useQuery(remoteViewStateQuery);
  return data ?? CLOSED_REMOTE_VIEW_STATE;
}

export function RemoteViewPanel({ choices }: { readonly choices: readonly RemoteChoice[] }) {
  const state = useRemoteViewState();
  const open = useOpenRemoteView();
  const close = useCloseRemoteView();
  const showing = state.open && choices.some((c) => c.request.target === state.target);

  if (showing) {
    return (
      <RemoteViewer
        state={state}
        closing={close.isPending}
        onDone={() => {
          close.mutate();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ItemGroup>
        {choices.map((choice) => (
          <Item key={choice.request.target} variant="outline">
            <ItemMedia variant="icon">
              <choice.icon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{choice.title}</ItemTitle>
              <ItemDescription>{choice.description}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                size="sm"
                isPending={open.isPending && open.variables.target === choice.request.target}
                onPress={() => {
                  open.mutate(choice.request);
                }}
              >
                {choice.action}
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      {state.open && state.target !== null && (
        <p className="text-sm text-muted-foreground">
          Facebook is open on {TARGET_NAMES[state.target]} somewhere else in faceslop. Opening one here switches it.
        </p>
      )}
      <InlineError error={open.error} />
    </div>
  );
}

interface RemoteViewDialogButtonProps {
  readonly request: OpenRemoteViewRequest;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly variant?: 'default' | 'outline';
}

/** A button that opens the remote view in a large dialog (e.g. a listing, from the item page). */
export function RemoteViewDialogButton({ request, title, description, children, variant = 'outline' }: RemoteViewDialogButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const state = useRemoteViewState();
  const open = useOpenRemoteView();
  const close = useCloseRemoteView();
  const showing = dialogOpen && state.open && state.target === request.target;

  const done = () => {
    close.mutate(undefined, {
      onSettled: () => {
        setDialogOpen(false);
      },
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={variant}
        isPending={open.isPending}
        onPress={() => {
          open.mutate(request, {
            onSuccess: () => {
              setDialogOpen(true);
            },
          });
        }}
      >
        {children}
      </Button>
      <InlineError error={open.error} />
      <Dialog
        isOpen={showing}
        onOpenChange={(next) => {
          if (!next) done();
        }}
        isDismissable={false}
        isKeyboardDismissDisabled
        showCloseButton={false}
        className="sm:max-w-6xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <RemoteViewer state={state} closing={close.isPending} onDone={done} inDialog />
      </Dialog>
    </div>
  );
}
