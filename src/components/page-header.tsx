import type { ReactNode } from 'react';

/** A page's title and a sentence about it. */
export function PageHeader({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children !== undefined && <p className="mt-2 max-w-prose text-muted-foreground">{children}</p>}
    </header>
  );
}
