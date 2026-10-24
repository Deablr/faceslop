import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, createFileRoute } from '@tanstack/react-router';
import { ChevronDown, LogIn, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { ErrorState, InlineError } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { RemoteViewer } from '@/components/remote-viewer/remote-viewer';
import { useRemoteViewState } from '@/components/remote-viewer/remote-view-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  useCancelLogin,
  useCloseRemoteView,
  useFacebookLogout,
  useOpenRemoteView,
  usePasswordLogin,
  useSubmitLoginCode,
} from '@/hooks/mutations';
import { authStatusQuery, queryKeys, remoteViewStateQuery, settled } from '@/lib/queries';
import type { AuthState, AuthStatus } from '@/shared/domain';

/** States where Facebook is mid-login and the status changes by itself. */
const POLLING_STATES = new Set<AuthState>(['window_open', 'needs_approval', 'logging_in']);
const FLOW_STATES = new Set<AuthState>([...POLLING_STATES, 'needs_code']);
const POLL_MS = 1500;

export const Route = createFileRoute('/_app/login')({
  loader: ({ context: { queryClient } }) => settled(queryClient.query({ ...remoteViewStateQuery, staleTime: 'static' })),
  head: () => ({ meta: [{ title: 'Connect Facebook · faceslop' }] }),
  component: LoginPage,
});

function LoginPage() {
  const view = useRemoteViewState();
  const loginViewOpen = view.open && view.target === 'login';
  const auth = useQuery({
    ...authStatusQuery,
    refetchInterval: (query) =>
      loginViewOpen || (query.state.data !== undefined && POLLING_STATES.has(query.state.data.state)) ? POLL_MS : false,
  });
  // Set once a login flow is under way here, so finishing it goes home (just visiting while logged in
  // doesn't). Finishing also changes whose data this browser shows; src/lib/account-change.ts
  // refreshes it when the status poll sees the new account.
  const [inFlow, setInFlow] = useState(false);
  const status = auth.data;
  if (status !== undefined && FLOW_STATES.has(status.state) && !inFlow) setInFlow(true);

  if (inFlow && status?.state === 'logged_in') return <Navigate to="/" />;

  let body: ReactNode;
  if (loginViewOpen) {
    body = <LoginView />;
  } else if (auth.isPending) {
    body = <Skeleton className="h-56 w-full" />;
  } else if (auth.isError) {
    body = (
      <ErrorState
        error={auth.error}
        onRetry={() => {
          void auth.refetch();
        }}
        retrying={auth.isFetching}
      />
    );
  } else {
    body = (
      <LoginBody
        status={auth.data}
        onStart={() => {
          setInFlow(true);
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-lg">
        <PageHeader title="Connect Facebook">
          Browsing works without an account. Connecting lets you message sellers and manage what you sell, still without
          the feed.
        </PageHeader>
      </div>
      {loginViewOpen ? body : <div className="mx-auto w-full max-w-lg">{body}</div>}
    </div>
  );
}

/** Facebook's own login page, shown live. The view closes itself once the session cookie appears. */
function LoginView() {
  const view = useRemoteViewState();
  const close = useCloseRemoteView();
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="mx-auto max-w-lg text-center text-sm text-muted-foreground">
        Log in on Facebook’s page below, including any security checks. faceslop continues by itself once you’re in.
      </p>
      <RemoteViewer
        state={view}
        doneLabel="Cancel"
        closing={close.isPending}
        onDone={() => {
          close.mutate();
        }}
      />
    </div>
  );
}

function LoginBody({ status, onStart }: { readonly status: AuthStatus; readonly onStart: () => void }) {
  switch (status.state) {
    case 'logged_in':
      return <Connected status={status} />;
    case 'window_open':
      return (
        <Waiting title="Waiting for the login page">
          Facebook’s login page is open in faceslop. If you closed it, start again below.
        </Waiting>
      );
    case 'needs_approval':
      return (
        <Waiting title="Approve the login on your phone" icon={<Smartphone className="size-5 text-primary" aria-hidden="true" />}>
          {status.message ?? 'Facebook sent a request to one of your other devices. Approve it there and this page continues.'}
        </Waiting>
      );
    case 'logging_in':
      return <Waiting title="Logging in…">This can take a few seconds.</Waiting>;
    case 'needs_code':
      return <CodeForm message={status.message} />;
    case 'logged_out':
    case 'error':
      return (
        <LoginOptions
          errorMessage={status.state === 'error' ? status.message : null}
          linkedTo={status.userId === null ? null : status}
          onStart={onStart}
        />
      );
  }
}

/** Who this browser is logged in as, and "Log out on this device" (other devices stay connected). */
function Connected({ status }: { readonly status: AuthStatus }) {
  const logout = useFacebookLogout();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Connected</h2>
        </CardTitle>
        <CardDescription>
          Connected as <span className="font-medium text-foreground">{status.userName ?? 'your Facebook account'}</span> on
          this device.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Other devices logged in to this Facebook account stay connected.</p>
        <InlineError error={logout.error} />
      </CardContent>
      <CardFooter>
        <div className="flex w-full flex-wrap gap-2">
          <Link to="/" className={buttonVariants()}>
            Go to faceslop
          </Link>
          <Link to="/settings" hash="facebook" className={buttonVariants({ variant: 'ghost' })}>
            Account settings
          </Link>
          <Button
            variant="outline"
            className="sm:ml-auto"
            isPending={logout.isPending}
            onPress={() => {
              logout.mutate(undefined);
            }}
          >
            <LogOut aria-hidden="true" />
            Log out on this device
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function Waiting({ title, icon, children }: { readonly title: string; readonly icon?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert role="status">
        {icon ?? <Spinner aria-hidden="true" />}
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{children}</AlertDescription>
      </Alert>
      <CancelLogin />
    </div>
  );
}

/** Give up on the login in progress (a stuck attempt, a code that never came) and start over. */
function CancelLogin() {
  const cancel = useCancelLogin();
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="ghost"
        isPending={cancel.isPending}
        onPress={() => {
          cancel.mutate(undefined);
        }}
      >
        Cancel and start over
      </Button>
      <InlineError error={cancel.error} />
    </div>
  );
}

interface LoginOptionsProps {
  readonly errorMessage: string | null;
  /** The account this browser is still linked to although its Facebook session ended (null: none). */
  readonly linkedTo: AuthStatus | null;
  readonly onStart: () => void;
}

function LoginOptions({ errorMessage, linkedTo, onStart }: LoginOptionsProps) {
  const queryClient = useQueryClient();
  const open = useOpenRemoteView();
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      {errorMessage !== null && (
        <Alert variant="destructive">
          <AlertTitle>That didn’t work</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Log in on Facebook’s own page</h2>
          </CardTitle>
          <CardDescription>
            Facebook’s login page opens right here. Two-factor codes and security checks work as usual. Your keystrokes go
            straight to Facebook’s page through the faceslop server and are never stored or logged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            size="lg"
            className="w-full"
            isPending={open.isPending}
            onPress={() => {
              onStart();
              open.mutate(
                { target: 'login' },
                {
                  onSuccess: () => {
                    void queryClient.invalidateQueries({ queryKey: queryKeys.auth });
                  },
                },
              );
            }}
          >
            <LogIn aria-hidden="true" />
            Log in with Facebook
          </Button>
          <InlineError error={open.error} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          className="self-start"
          aria-expanded={showPassword}
          onPress={() => {
            setShowPassword((s) => !s);
          }}
        >
          <ChevronDown aria-hidden="true" className="transition-transform group-aria-expanded/button:rotate-180" />
          Log in with email and password instead
        </Button>
        {showPassword && <PasswordForm onStart={onStart} />}
      </div>

      <Link to="/" className="self-center rounded-sm text-sm text-primary hover:underline">
        Continue without logging in
      </Link>
      {linkedTo !== null && <StillLinked status={linkedTo} />}
    </div>
  );
}

/**
 * This browser is still linked to an account whose Facebook session ended: logging in again
 * reconnects it, and "Log out on this device" unlinks it (what was saved stays with the account).
 */
function StillLinked({ status }: { readonly status: AuthStatus }) {
  const logout = useFacebookLogout();
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="text-sm text-muted-foreground">
        This browser is still linked to{' '}
        <span className="font-medium text-foreground">{status.userName ?? 'a Facebook account'}</span>, and what you save
        goes to that account.
      </p>
      <Button
        variant="ghost"
        size="sm"
        isPending={logout.isPending}
        onPress={() => {
          logout.mutate(undefined);
        }}
      >
        <LogOut aria-hidden="true" />
        Log out on this device
      </Button>
      <InlineError error={logout.error} />
    </div>
  );
}

function PasswordForm({ onStart }: { readonly onStart: () => void }) {
  const id = useId();
  const login = usePasswordLogin();

  // Uncontrolled inputs: the password is read once on submit and never kept in React state.
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = form.get('email');
    const password = form.get('password');
    if (typeof email !== 'string' || typeof password !== 'string' || email.trim() === '' || password === '') return;
    onStart();
    login.mutate({ email: email.trim(), password });
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-email`}>Email or phone</FieldLabel>
              <Input id={`${id}-email`} name="email" autoComplete="username" required />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-password`}>Facebook password</FieldLabel>
              <Input id={`${id}-password`} name="password" type="password" autoComplete="current-password" required />
              <FieldDescription>
                <ShieldCheck className="mr-1 inline size-4 align-text-bottom" aria-hidden="true" />
                Your password goes only to the faceslop server, and from there to Facebook. It is never stored or
                logged.
              </FieldDescription>
            </Field>
            <InlineError error={login.error} />
            <Button type="submit" className="w-full" isPending={login.isPending}>
              Log in
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function CodeForm({ message }: { readonly message: string | null }) {
  const id = useId();
  const submit = useSubmitLoginCode();
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get('code');
    const code = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
    if (code !== '') submit.mutate(code);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Enter your login code</h2>
        </CardTitle>
        <CardDescription>{message ?? 'Facebook sent a code to your phone or authentication app.'}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-code`}>Code</FieldLabel>
              <Input id={`${id}-code`} name="code" inputMode="numeric" autoComplete="one-time-code" required className="max-w-48" />
            </Field>
            <InlineError error={submit.error} />
            <Button type="submit" isPending={submit.isPending} className="self-start">
              Continue
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter>
        <CancelLogin />
      </CardFooter>
    </Card>
  );
}
