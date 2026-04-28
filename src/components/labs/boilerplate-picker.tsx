'use client';

/**
 * BoilerplatePicker — Pipeline v2 / Story 1.4.1.
 *
 * Radio group for selecting a boilerplate template in the New App modal.
 * Reads exclusively from the client-side registry view; never imports
 * the server registry. Stub types remain clickable so the saga code path
 * gets exercised even when the template is empty.
 */

import { Label } from '@/components/ui/label';
import {
  BOILERPLATE_CLIENT_VIEW,
  type BoilerplateClientView,
} from '@/lib/boilerplate-registry-client-view';
import type { BoilerplateType } from '@/types/app';

interface BoilerplatePickerProps {
  value: BoilerplateType;
  onChange: (next: BoilerplateType) => void;
  disabled?: boolean;
}

export function BoilerplatePicker({ value, onChange, disabled = false }: BoilerplatePickerProps) {
  return (
    <div className="space-y-1.5">
      <Label>Boilerplate *</Label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {BOILERPLATE_CLIENT_VIEW.map((view) => (
          <BoilerplateOption
            key={view.type}
            view={view}
            checked={value === view.type}
            onSelect={() => onChange(view.type)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

function BoilerplateOption({
  view,
  checked,
  onSelect,
  disabled,
}: {
  view: BoilerplateClientView;
  checked: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  return (
    <label
      className={[
        'flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors',
        checked ? 'border-accent-blue bg-accent-blue/5' : 'border-border hover:bg-muted/40',
        disabled ? 'cursor-not-allowed opacity-60' : '',
      ].join(' ')}
    >
      <input
        type="radio"
        name="boilerplate-type"
        value={view.type}
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        className="mt-1"
      />
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-lg">{view.icon}</span>
          <span className="font-medium">{view.displayName}</span>
          {view.status === 'stub' && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
              stub
            </span>
          )}
        </div>
        {view.stubHint && <p className="mt-1 text-xs text-muted-foreground">{view.stubHint}</p>}
      </div>
    </label>
  );
}
