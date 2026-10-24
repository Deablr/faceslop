import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LogOut, ShieldCheck } from 'lucide-react';
import { ErrorState, InlineError } from '@/components/error-state';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppLogout, useFacebookLogout, useVerifyFacebookSession } from '@/hooks/mutations';
import { accountOf } from '@/lib/account-change';
import { appAuthQuery, authStatusQuery } from '@/lib/queries';
import type { AuthState } from '@/shared/domain';

const IN_PROGRESS = new Set<AuthState>(['logging_in', 'needs_code', 'needs_approval', 'window_open']);

export function FacebookAccountSection() {
  const auth = useQuery(authStatusQuery);
  const logout = useFacebookLogout();
  const verify = useVerifyFacebookSession();

  // Unbinds this browser whenever it is bound to an account, even after that account's Facebook
  // session ended (its saved things keep going to the account until then).
  const logoutButton = (
    <Button
      variant="outline"
      size="sm"
      isPending={logout.isPending}
      onPress={() => {
        logout.mutate(undefined);
      }}
    >
      <LogOut aria-hidden="true" />
      Log out on this device
    </Button>
  );

  let body;
  if (auth.isPending) body = <Skeleton className="h-9 w-full" />;
  else if (auth.isError) {
    body = (
      <ErrorState
        error={auth.error}
        onRetry={() => {
          void auth.refetch();
        }}
      />
    );
  } else if (auth.data.state === 'logged_in') {
    const status = auth.data;
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Connected as <span className="font-medium text-foreground">{status.userName ?? 'your Facebook account'}</span>
            {verify.isSuccess && verify.data.state === 'logged_in' && <span> · the session works</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              isPending={verify.isPending}
              onPress={() => {
                verify.mutate(undefined);
              }}
            >
              <ShieldCheck aria-hidden="true" />
              Check connection
            </Button>
            {logoutButton}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Other devices logged in to this Facebook account stay connected.</p>
      </div>
    );
  } else {
    const status = auth.data;
    const inProgress = IN_PROGRESS.has(status.state);
    const linked = accountOf(status) !== null;
    let message = 'Not connected.';
    if (inProgress) message = 'A login is in progress.';
    else if (status.message !== null) message = status.message;
    else if (linked) message = 'Your Facebook session ended.';
    else if (status.state === 'error') message = 'The last login attempt failed.';
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{message}</p>
          <div className="flex flex-wrap gap-2">
            <Link to="/login" className={buttonVariants({ size: 'sm' })}>
              {inProgress ? 'Continue logging in' : linked ? 'Log in again' : 'Connect Facebook'}
            </Link>
            {linked && logoutButton}
          </div>
        </div>
        {linked && (
          <p className="text-sm text-muted-foreground">
            This browser stays linked to{' '}
            <span className="font-medium text-foreground">{status.userName ?? 'its Facebook account'}</span>, and what you
            save goes to that account, until you log out on this device.
          </p>
        )}
      </div>
    );
  }

  return (
    <SettingsSection
      id="facebook"
      title="Facebook account"
      description="Browsing works without it. Messaging sellers and selling need it."
    >
      {body}
      <InlineError error={logout.error ?? verify.error} />
    </SettingsSection>
  );
}

/** Only shown when the server requires an app password (APP_PASSWORD). Unlocking never expires. */
export function AppLockSection() {
  const { data } = useQuery(appAuthQuery);
  const lock = useAppLogout();
  if (data?.required !== true) return null;
  return (
    <SettingsSection
      title="This browser"
      description="faceslop is password-protected, and this browser stays unlocked until you lock it here. Locking keeps your Facebook connection and saved things."
    >
      <div className="flex flex-col items-start gap-2">
        <Button
          variant="outline"
          size="sm"
          isPending={lock.isPending}
          onPress={() => {
            lock.mutate();
          }}
        >
          Lock faceslop on this browser
        </Button>
        <InlineError error={lock.error} />
      </div>
    </SettingsSection>
  );
}
