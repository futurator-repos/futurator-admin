'use client';

import { ThemeToggle } from './theme-toggle';
import { UserDropdown } from './user-dropdown';

export function Header() {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
      <div />
      <div className="flex items-center gap-1.5">
        <ThemeToggle />
        <UserDropdown />
      </div>
    </header>
  );
}
