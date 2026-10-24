import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface SettingsSectionProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** Anchor for deep links (e.g. /settings#facebook). */
  readonly id?: string;
  readonly children: ReactNode;
}

export function SettingsSection({ title, description, id, children }: SettingsSectionProps) {
  const headingId = `${id ?? title.toLowerCase().replace(/\W+/g, '-')}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-24">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={headingId}>{title}</h2>
          </CardTitle>
          {description !== undefined && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}
