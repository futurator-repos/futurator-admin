'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * IconPicker — emoji picker for App.icon (Pipeline v2 / Story 1.4.1).
 *
 * Three ways to set the icon:
 *   1. Click any emoji in the categorized grid (most common)
 *   2. Hit "Surprise me" — pulls a random emoji from CURATED_POOL
 *   3. Toggle "Custom" — freeform text input (1–4 chars; allows multi-codepoint
 *      emoji, ZWJ sequences, regional flags, etc.)
 *
 * Curated pool is intentionally small + opinionated — broad enough to give
 * an App identity, narrow enough that scrolling stays cheap. Unicode 15+
 * codepoints used; older OS renderers may show fallback boxes for a few.
 */

type Category = {
  name: string;
  emojis: string[];
};

const CATEGORIES: Category[] = [
  {
    name: 'Apps & Tools',
    emojis: ['📦', '⚙️', '🛠️', '🔧', '🧰', '🔨', '🪛', '🧪', '🧬', '💼', '📊', '📈'],
  },
  {
    name: 'Tech',
    emojis: ['💻', '⌨️', '🖥️', '📱', '💾', '💿', '🖨️', '📡', '🔌', '🔋', '⚡', '🛜'],
  },
  {
    name: 'Speed & Action',
    emojis: ['🚀', '🛸', '✈️', '🏎️', '🏁', '🎯', '⚡', '💥', '🎬', '🎮', '▶️', '🌟'],
  },
  {
    name: 'Creatures',
    emojis: ['🦖', '🦕', '🐉', '🦄', '🐲', '🦅', '🦉', '🦊', '🦁', '🐺', '🐱', '🦝'],
  },
  {
    name: 'Nature',
    emojis: ['🌍', '🌌', '🌠', '☄️', '⭐', '🌙', '☀️', '🔥', '🌊', '🌳', '🌵', '🍃'],
  },
  {
    name: 'Magic & Mind',
    emojis: ['🧠', '🔮', '🎩', '✨', '🪄', '💡', '🔬', '🔭', '⚗️', '🎲', '🪐', '👁️'],
  },
  {
    name: 'Food & Vibes',
    emojis: ['🍕', '🍔', '🌮', '🍣', '🍩', '☕', '🍷', '🍻', '🍿', '🥑', '🌶️', '🍒'],
  },
  {
    name: 'Symbols',
    emojis: ['💎', '🎨', '🎭', '🏆', '🥇', '🎁', '⚛️', '☯️', '⚖️', '🔱', '⚔️', '🛡️'],
  },
];

const CURATED_POOL = CATEGORIES.flatMap((c) => c.emojis);

export function IconPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [customMode, setCustomMode] = useState(false);

  const handleRandom = () => {
    const next = CURATED_POOL[Math.floor(Math.random() * CURATED_POOL.length)];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Icon</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRandom}
            disabled={disabled}
            className="text-xs h-7 px-2"
          >
            🎲 Surprise me
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCustomMode((v) => !v)}
            disabled={disabled}
            className="text-xs h-7 px-2"
          >
            {customMode ? 'Pick from grid' : 'Custom'}
          </Button>
        </div>
      </div>

      {/* Selected icon — big preview */}
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-3">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-background text-3xl shadow-sm"
          aria-label="Selected app icon"
        >
          {value || '📦'}
        </div>
        <div className="text-xs text-muted-foreground">
          {customMode
            ? 'Type any emoji or short symbol below.'
            : `Click any emoji to pick. ${CURATED_POOL.length} curated options across ${CATEGORIES.length} categories.`}
        </div>
      </div>

      {customMode ? (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={4}
          className="w-24 text-center text-2xl"
          placeholder="📦"
          disabled={disabled}
          autoFocus
        />
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border border-border p-3">
          {CATEGORIES.map((cat) => (
            <div key={cat.name} className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">{cat.name}</div>
              <div className="grid grid-cols-12 gap-1">
                {cat.emojis.map((e) => {
                  const selected = e === value;
                  return (
                    <button
                      key={e}
                      type="button"
                      onClick={() => onChange(e)}
                      disabled={disabled}
                      aria-label={`Pick ${e}`}
                      aria-pressed={selected}
                      className={cn(
                        'flex h-9 w-9 items-center justify-center rounded text-xl transition-colors',
                        'hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent',
                        selected && 'bg-accent ring-2 ring-primary',
                      )}
                    >
                      {e}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
