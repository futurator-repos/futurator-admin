'use client';

import { ThemeToggle } from './theme-toggle';
import { UserDropdown } from './user-dropdown';
import { GlobalAttentionBell } from './global-attention-bell';

export function Header() {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
      <div />
      <div className="flex items-center gap-1.5">
        {/* Pipeline v2.0 PR-7 (J): cross-plan attention surface, visible
            on every page so an operator on the Apps grid / Settings sees
            failures from any in-flight plan without navigating in. */}
        <GlobalAttentionBell />
        <ThemeToggle />
        <UserDropdown />
      </div>
    </header>
  );
}
