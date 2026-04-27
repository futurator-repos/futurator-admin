'use client';
/**
 * Pipeline v1 — Story 6.5. User profile settings.
 *
 * Minimal page: toggle email digest, set timezone. Email is read-only
 * (sourced from JWT). The daemon's batch scheduler honors `timezone`
 * (Story 6.2 — once timezone-aware date math is plumbed; v1 falls back
 * to UTC).
 */
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Button } from '@/components/ui/button';

interface Profile {
  userId: string;
  email: string;
  emailDigestEnabled: boolean;
  timezone: string;
}

const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

function SettingsContent() {
  const { data, refetch } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<Profile>('/profile'),
  });

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  // Re-mount the form when the underlying user changes by keying on userId,
  // so form state always seeds from a fresh `data` snapshot via initial-
  // value props rather than a setState-in-effect mirror.
  return <SettingsForm key={data.userId} initial={data} refetch={refetch} />;
}

function SettingsForm({ initial, refetch }: { initial: Profile; refetch: () => unknown }) {
  const [digest, setDigest] = useState(initial.emailDigestEnabled);
  const [tz, setTz] = useState(initial.timezone || 'UTC');
  const data = initial;

  const save = useMutation({
    mutationFn: () => api.put('/profile', { emailDigestEnabled: digest, timezone: tz }),
    onSuccess: () => refetch(),
  });

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-page-title">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Personal preferences. Applied per-user; the daemon picks them up via the users table.
        </p>
      </div>

      <div className="rounded border bg-card p-4 space-y-4">
        <div>
          <label className="text-xs text-muted-foreground">Email</label>
          <div className="text-sm font-mono">{data.email}</div>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Email digest</div>
            <div className="text-xs text-muted-foreground">
              Hourly summary of unresolved attention items. Off by default.
            </div>
          </div>
          <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Timezone</div>
            <div className="text-xs text-muted-foreground">
              Used by the nightly/weekend batch scheduler.
            </div>
          </div>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="text-sm px-2 py-1 rounded border bg-background"
          >
            {COMMON_TIMEZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <AuthGuard>
      <AppShell>
        <SettingsContent />
      </AppShell>
    </AuthGuard>
  );
}
