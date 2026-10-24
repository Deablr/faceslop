import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          {children !== undefined && <EmptyDescription>{children}</EmptyDescription>}
        </EmptyHeader>
        {action !== undefined && <EmptyContent>{action}</EmptyContent>}
      </Empty>
    </div>
  );
}
