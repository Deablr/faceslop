import { useId, useState } from 'react';
import { LocationPicker } from '@/components/location-picker';
import { RadiusSelect } from '@/components/radius-select';
import { SelectField } from '@/components/select-field';
import { KeywordInput } from '@/components/settings/keyword-input';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { useNotificationPermission } from '@/hooks/use-notification-permission';
import { requestNotificationPermission } from '@/lib/notifications';
import type { Settings, SettingsPatch } from '@/shared/domain';

const CHECK_INTERVALS = [0, 15, 30, 60, 120, 240, 720, 1440];
const NUDGE_MINUTES = [0, 10, 15, 20, 30, 45, 60, 90];

function everyLabel(minutes: number): string {
  if (minutes === 0) return 'Off';
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${String(minutes / 60)} hours`;
  return `Every ${String(minutes)} minutes`;
}

function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

interface PreferenceSectionsProps {
  readonly settings: Settings;
  readonly onChange: (patch: SettingsPatch) => void;
}

export function PreferenceSections({ settings, onChange }: PreferenceSectionsProps) {
  const id = useId();
  return (
    <>
      <SettingsSection title="Searching" description="Used when you start a new search. You can still change it per search.">
        <FieldGroup>
          <LocationPicker
            label="Default location"
            value={settings.defaultLocation}
            onChange={(defaultLocation) => {
              onChange({ defaultLocation });
            }}
          />
          <div className="max-w-xs">
            <RadiusSelect
              label="Default distance"
              value={settings.defaultRadiusKm}
              onChange={(km) => {
                onChange({ defaultRadiusKm: km ?? null });
              }}
            />
          </div>
        </FieldGroup>
      </SettingsSection>

      <SettingsSection
        title="Filtering"
        description="Listings whose titles contain any of these words are left out of results (not case-sensitive)."
      >
        <Field>
          <FieldLabel htmlFor={`${id}-keywords`}>Excluded keywords</FieldLabel>
          <KeywordInput
            id={`${id}-keywords`}
            values={settings.excludedKeywords}
            onChange={(excludedKeywords) => {
              onChange({ excludedKeywords });
            }}
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Background checks"
        description="While faceslop is running, it quietly re-runs saved searches (with auto-check on) and refreshes favorites, one at a time."
      >
        <div className="max-w-xs">
          <SelectField
            label="Check"
            value={String(settings.checkIntervalMinutes)}
            onChange={(value) => {
              onChange({ checkIntervalMinutes: Number(value) });
            }}
            options={withCurrent(CHECK_INTERVALS, settings.checkIntervalMinutes).map((m) => ({ id: String(m), label: everyLabel(m) }))}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Wellbeing" description="Small guardrails so a quick look stays a quick look.">
        <FieldGroup>
          <div className="max-w-xs">
            <SelectField
              label="Remind me I’ve been browsing after"
              value={String(settings.sessionNudgeMinutes)}
              onChange={(value) => {
                onChange({ sessionNudgeMinutes: Number(value) });
              }}
              options={withCurrent(NUDGE_MINUTES, settings.sessionNudgeMinutes).map((m) => ({
                id: String(m),
                label: m === 0 ? 'Never' : `${String(m)} minutes`,
              }))}
            />
          </div>
          <NotificationsToggle enabled={settings.desktopNotifications} onChange={onChange} />
        </FieldGroup>
      </SettingsSection>
    </>
  );
}

/** Off by default. Turning it on asks the browser for permission first. */
function NotificationsToggle({ enabled, onChange }: { readonly enabled: boolean; readonly onChange: (patch: SettingsPatch) => void }) {
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const permission = useNotificationPermission();

  const toggle = async (on: boolean) => {
    setProblem(null);
    if (!on) {
      onChange({ desktopNotifications: false });
      return;
    }
    const permission = await requestNotificationPermission();
    if (permission === 'granted') onChange({ desktopNotifications: true });
    else if (permission === 'unsupported') setProblem('This browser can’t show notifications here (they need localhost or HTTPS).');
    else setProblem('Notifications are blocked for this site. You can allow them in your browser’s site settings.');
  };

  const askHere = async () => {
    setProblem(null);
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') setProblem('Notifications are blocked for this site. You can allow them in your browser’s site settings.');
  };

  // Unknown until hydrated (the server can't know), so SSR and the first client render agree. The
  // setting follows the account, but permission is per browser: another device may not have
  // been asked yet ('default'), which is not "blocked".
  const notAskedHere = enabled && problem === null && permission === 'default';
  const blockedNow = enabled && problem === null && (permission === 'denied' || permission === 'unsupported');
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>Desktop notifications</FieldLabel>
        <FieldDescription>Only for saved searches with new listings, and only while a faceslop tab is open.</FieldDescription>
        {notAskedHere && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onPress={() => {
              void askHere();
            }}
          >
            Allow notifications in this browser
          </Button>
        )}
        <FieldError>{problem ?? (blockedNow ? 'Your browser isn’t allowing notifications from faceslop right now.' : null)}</FieldError>
      </FieldContent>
      <Switch
        id={id}
        isSelected={enabled}
        onChange={(on) => {
          void toggle(on);
        }}
        aria-label="Desktop notifications"
      />
    </Field>
  );
}
