import { Lock } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { InlineError } from '@/components/error-state';
import { LogoMark } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAppLogin } from '@/hooks/mutations';

/**
 * Full-screen gate when the server has APP_PASSWORD set and this browser hasn't entered it (or the
 * password changed since). Unlocking never expires: it lasts until this browser is locked again.
 */
export function AppLockScreen() {
  const id = useId();
  const login = useAppLogin();

  // Uncontrolled: the password is read once on submit and never kept in React state.
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    // One unlock at a time: a second one would arrive with the token the first just replaced.
    if (login.isPending) return;
    const raw = new FormData(e.currentTarget).get('password');
    if (typeof raw === 'string' && raw !== '') login.mutate(raw);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <title>Locked · faceslop</title>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <LogoMark className="mb-3 size-9" />
          <CardTitle>
            <h1>faceslop is locked</h1>
          </CardTitle>
          <CardDescription>
            Enter the app password to continue. This browser then stays unlocked until it’s locked in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id={`${id}-form`} onSubmit={onSubmit}>
            <Field>
              <FieldLabel htmlFor={`${id}-pw`}>App password</FieldLabel>
              <Input id={`${id}-pw`} name="password" type="password" autoComplete="current-password" required />
              <InlineError error={login.error} />
            </Field>
          </form>
        </CardContent>
        <CardFooter className="flex-col items-stretch">
          <Button type="submit" form={`${id}-form`} isPending={login.isPending} className="w-full">
            <Lock aria-hidden="true" />
            Unlock
          </Button>
          <p className="mt-4 text-xs text-muted-foreground">
            This is the password set with APP_PASSWORD on the faceslop server. It isn’t your Facebook password.
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
