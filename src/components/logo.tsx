import { cn } from '@/lib/utils';

/** The faceslop mark (public/favicon.svg), drawn with theme tokens so it follows light/dark. */
export function LogoMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-7 shrink-0', className)} aria-hidden="true">
      <rect width="64" height="64" rx="14" className="fill-brand" />
      <text
        x="32"
        y="32"
        dy="0.35em"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
        fontSize="32"
        fontWeight="600"
        className="fill-brand-foreground"
      >
        F
      </text>
    </svg>
  );
}

/** Mark + lowercase wordmark. `compact` hides the wordmark visually on phones (still read out). */
export function Logo({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark />
      {compact ? (
        <span className="text-lg font-semibold tracking-tight max-sm:sr-only">faceslop</span>
      ) : (
        <span className="text-lg font-semibold tracking-tight">faceslop</span>
      )}
    </span>
  );
}
