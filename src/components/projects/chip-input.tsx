'use client';
import { useState, useRef } from 'react';
import { X } from 'lucide-react';

type ChipVariant = 'aws' | 'ai' | 'integration' | 'default';

interface ChipInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions?: string[];
  variant?: ChipVariant;
  placeholder?: string;
}

const variantStyles: Record<ChipVariant, string> = {
  aws: 'bg-warning/10 text-warning border-warning/25',
  ai: 'bg-accent-purple/10 text-accent-purple border-accent-purple/25',
  integration: 'bg-success/10 text-success border-success/25',
  default: 'bg-muted text-foreground border-border',
};

export function ChipInput({
  value,
  onChange,
  suggestions = [],
  variant = 'default',
  placeholder = 'Add...',
}: ChipInputProps) {
  const [query, setQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = suggestions
    .filter((s) => !value.includes(s) && s.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  const addChip = (item: string) => {
    if (!value.includes(item)) {
      onChange([...value, item]);
    }
    setQuery('');
    setShowSuggestions(false);
    setHighlightIndex(-1);
    inputRef.current?.focus();
  };

  const removeChip = (item: string) => {
    onChange(value.filter((v) => v !== item));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && query === '' && value.length > 0) {
      removeChip(value[value.length - 1]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && filtered[highlightIndex]) {
        addChip(filtered[highlightIndex]);
      } else if (query.trim()) {
        addChip(query.trim());
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  return (
    <div className="relative">
      <div
        className="flex min-h-[36px] flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1 focus-within:border-accent-blue focus-within:ring-1 focus-within:ring-accent-blue/30"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((item) => (
          <span
            key={item}
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] border ${variantStyles[variant]}`}
          >
            {item}
            <button
              type="button"
              onClick={() => removeChip(item)}
              className="opacity-60 hover:opacity-100"
              aria-label={`Remove ${item}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowSuggestions(true);
            setHighlightIndex(-1);
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ''}
          className="min-w-[60px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          aria-label={placeholder}
        />
      </div>

      {showSuggestions && query && filtered.length > 0 && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-md border border-border bg-popover shadow-md"
          role="listbox"
        >
          {filtered.map((item, i) => (
            <button
              key={item}
              type="button"
              role="option"
              aria-selected={i === highlightIndex}
              className={`w-full px-3 py-1.5 text-left text-xs hover:bg-accent ${i === highlightIndex ? 'bg-accent' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                addChip(item);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
