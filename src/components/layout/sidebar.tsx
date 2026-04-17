'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

interface NavSection {
  label: string;
  icon: string;
  items: NavItem[];
}

const mainItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/projects', label: 'Projects', icon: '📁' },
  { href: '/costs', label: 'Costs', icon: '💰' },
  { href: '/resources', label: 'Resources', icon: '🔧' },
  { href: '/schedules', label: 'Schedules', icon: '⏰' },
  { href: '/users', label: 'Users', icon: '👥' },
  { href: '/alerts', label: 'Alerts', icon: '🔔' },
  { href: '/reports', label: 'Reports', icon: '📈' },
];

const sections: NavSection[] = [
  {
    label: 'Development',
    icon: '🛠️',
    items: [
      { href: '/development/files', label: 'File Explorer', icon: '📂' },
      { href: '/development/apps', label: 'Apps', icon: '🚀' },
      { href: '/development/monitor', label: 'EC2 Monitor', icon: '📊' },
      { href: '/development/agentic-office', label: 'Agentic Office', icon: '🏢' },
      { href: '/labs', label: 'Labs', icon: '🧪' },
    ],
  },
];

function NavLink({
  item,
  collapsed,
  isActive,
}: {
  item: NavItem;
  collapsed: boolean;
  isActive: boolean;
}) {
  return (
    <Link
      href={item.href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <span>{item.icon}</span>
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );
}

function SectionGroup({
  section,
  collapsed,
  pathname,
}: {
  section: NavSection;
  collapsed: boolean;
  pathname: string;
}) {
  const hasActiveChild = section.items.some((item) => pathname.startsWith(item.href));
  const [open, setOpen] = useState(hasActiveChild);

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          hasActiveChild
            ? 'text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        )}
      >
        <span>{section.icon}</span>
        {!collapsed && (
          <>
            <span className="flex-1 text-left">{section.label}</span>
            <span
              className="text-xs text-muted-foreground transition-transform"
              style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              ▸
            </span>
          </>
        )}
      </button>
      {(open || collapsed) && (
        <div className={cn(!collapsed && 'ml-4 border-l border-border pl-1')}>
          {section.items.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <NavLink key={item.href} item={item} collapsed={collapsed} isActive={isActive} />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarCollapsed, toggleSidebar } = useUIStore();

  return (
    <aside
      className={cn(
        'flex h-screen flex-col border-r border-border bg-card transition-all',
        sidebarCollapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className="flex h-14 items-center border-b border-border px-4">
        {!sidebarCollapsed && <span className="text-lg font-semibold">Futurator Admin</span>}
        <button
          onClick={toggleSidebar}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          {sidebarCollapsed ? '\u2192' : '\u2190'}
        </button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {mainItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <NavLink key={item.href} item={item} collapsed={sidebarCollapsed} isActive={isActive} />
          );
        })}

        <div className="my-2 border-t border-border" />

        {sections.map((section) => (
          <SectionGroup
            key={section.label}
            section={section}
            collapsed={sidebarCollapsed}
            pathname={pathname}
          />
        ))}
      </nav>
    </aside>
  );
}
