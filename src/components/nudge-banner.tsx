import { useNavigate } from '@tanstack/react-router';
import { Coffee, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SessionNudge } from '@/hooks/use-session-nudge';

/** "You've been browsing a while": a calm, dismissible reminder, never a modal. */
export function NudgeBanner({ nudge }: { readonly nudge: SessionNudge }) {
  const navigate = useNavigate();
  return (
    <section aria-label="Browsing reminder" className="border-b bg-accent">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Coffee className="size-5 shrink-0 text-accent-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-accent-foreground">
          You’ve been browsing for {nudge.minutesBrowsed} minutes. Found what you came for?
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onPress={() => {
              nudge.reset();
              void navigate({ to: '/closed' });
            }}
          >
            I’m done for now
          </Button>
          <Button size="sm" variant="outline" onPress={nudge.snooze}>
            5 more minutes
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss reminder" onPress={nudge.dismiss}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}
