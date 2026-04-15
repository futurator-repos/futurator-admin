'use client';

import { useAuthStore } from '@/stores/auth-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Compact user menu intended for the header (top right). The trigger is just
 * the avatar circle — the user name and email live inside the dropdown panel.
 *
 * The theme toggle has been extracted into its own button at
 * `theme-toggle.tsx` and is rendered to the LEFT of this component in the
 * header, so it is intentionally NOT included in this menu.
 */
export function UserDropdown() {
  const { user, logout } = useAuthStore();

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '??';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="User menu"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-accent-purple bg-accent-purple/10 text-xs font-medium text-accent-purple">
          {initials}
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-[220px]">
        <div className="px-2 py-1.5">
          <div className="truncate text-sm font-medium text-foreground">{user?.name || 'User'}</div>
          <div className="truncate text-xs text-muted-foreground">{user?.email || ''}</div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <span>{'\u2699\uFE0F'} Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => logout()}
          className="text-destructive focus:text-destructive"
        >
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
