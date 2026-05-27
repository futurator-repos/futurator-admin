'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import { UserDropdown } from './user-dropdown';
import { GlobalAttentionBell } from './global-attention-bell';
import { AgentPauseToggle } from './agent-pause-toggle';
import { AgentSpendPill } from './agent-spend-pill';
import { RuntimeControls } from '@/components/labs/runtime-controls';
import { useUIStore } from '@/stores/ui-store';

export function Header() {
  const breadcrumbs = useUIStore((s) => s.headerBreadcrumbs);

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
      <HeaderBreadcrumbs items={breadcrumbs} />
      <div className="flex items-center gap-3">
        {/* Daemon + Claude Code panels — globally visible so the operator
            always sees the runtime state regardless of which page they're on. */}
        <RuntimeControls />
        {/* 2026-05-27 PR B.f — global agent pause/resume. Daemon obeys
            the flag before claiming any PENDING job. Visible everywhere
            for the same reason RuntimeControls is. */}
        <AgentPauseToggle />
        {/* 2026-05-27 PR B.c — today's accumulated agent spend (UTC day).
            Hidden until at least one spend row exists today. */}
        <AgentSpendPill />
        {/* Pipeline v2.0 PR-7 (J): cross-plan attention surface, visible
            on every page so an operator on the Apps grid / Settings sees
            failures from any in-flight plan without navigating in. */}
        <div className="flex items-center gap-1.5">
          <GlobalAttentionBell />
          <ThemeToggle />
          <UserDropdown />
        </div>
      </div>
    </header>
  );
}

function HeaderBreadcrumbs({
  items,
}: {
  items: ReturnType<typeof useUIStore.getState>['headerBreadcrumbs'];
}) {
  if (!items || items.length === 0) return <div />;
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground"
    >
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        const content = (
          <span
            className={
              isLast
                ? 'truncate text-foreground font-medium'
                : 'truncate hover:text-foreground transition-colors'
            }
            title={item.label}
          >
            {item.label}
          </span>
        );
        return (
          <span key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />}
            {item.href && !isLast ? (
              <Link href={item.href} className="min-w-0">
                {content}
              </Link>
            ) : (
              content
            )}
          </span>
        );
      })}
    </nav>
  );
}
