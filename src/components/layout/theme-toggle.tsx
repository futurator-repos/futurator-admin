'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';

const emptySubscribe = () => () => {};
const returnTrue = () => true;
const returnFalse = () => false;

/**
 * Standalone theme toggle button intended to live in the header next to the
 * UserDropdown. Renders a sun/moon icon based on the resolved theme. Uses
 * `next-themes` for state. Avoids hydration mismatch by deferring icon render
 * until the client has mounted.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(emptySubscribe, returnTrue, returnFalse);

  if (!mounted) {
    // Placeholder square so the header layout doesn't jump on hydration
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Toggle theme"
        className="text-muted-foreground"
      >
        <span className="size-4" />
      </Button>
    );
  }

  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="text-muted-foreground hover:text-foreground"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
