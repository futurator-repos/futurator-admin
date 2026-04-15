'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';

interface DescriptionFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  multiline?: boolean;
  rows?: number;
  showHomepageFlag?: boolean;
  homepageFlagged?: boolean;
  onHomepageFlagChange?: (checked: boolean) => void;
  placeholder?: string;
}

export function DescriptionField({
  label,
  value,
  onChange,
  maxLength,
  multiline = false,
  rows = 2,
  showHomepageFlag = false,
  homepageFlagged = false,
  onHomepageFlagChange,
  placeholder,
}: DescriptionFieldProps) {
  const count = value.length;
  const pct = count / maxLength;
  const counterColor =
    pct >= 1
      ? 'text-destructive'
      : pct >= 0.9
        ? 'text-yellow-600 dark:text-yellow-400'
        : 'text-muted-foreground';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">{label}</label>
          {showHomepageFlag && (
            <div className="flex items-center gap-1.5">
              <Checkbox
                checked={homepageFlagged}
                onCheckedChange={(checked) => onHomepageFlagChange?.(checked === true)}
                className="size-3.5"
              />
              <span className="text-[10px] text-muted-foreground">homepage</span>
            </div>
          )}
        </div>
        <span className={`text-[10px] font-mono ${counterColor}`} aria-live="polite">
          {count}/{maxLength}
        </span>
      </div>
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className="text-sm"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="text-sm"
        />
      )}
    </div>
  );
}
