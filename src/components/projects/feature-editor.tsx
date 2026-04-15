'use client';
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ChipInput } from './chip-input';
import { Plus, Trash2 } from 'lucide-react';
import { AWS_SERVICES, AI_PROVIDERS, INTEGRATIONS } from '@/lib/constants';
import type { Feature, ProjectStatus } from '@/types/project';

interface FeatureEditorProps {
  features: Feature[];
  onChange: (features: Feature[]) => void;
}

export function FeatureEditor({ features, onChange }: FeatureEditorProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Story 13-2 [Low] follow-up: auto-focus the most-recently-added feature's
  // name input. We track the freshly-added feature ID separately rather than
  // using `autoFocus` on every input, to avoid stealing focus from other inputs
  // on every re-render.
  const newFeatureIdRef = useRef<string | null>(null);
  const nameInputRefs = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    if (newFeatureIdRef.current) {
      const input = nameInputRefs.current.get(newFeatureIdRef.current);
      input?.focus();
      newFeatureIdRef.current = null;
    }
  }, [features]);

  const updateFeature = (id: string, updates: Partial<Feature>) => {
    onChange(features.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  };

  const addFeature = () => {
    const newFeature: Feature = {
      id: crypto.randomUUID(),
      name: '',
      status: 'planning',
      awsServices: [],
      aiProviders: [],
      integrations: [],
    };
    newFeatureIdRef.current = newFeature.id;
    onChange([...features, newFeature]);
  };

  const removeFeature = (id: string) => {
    onChange(features.filter((f) => f.id !== id));
    setConfirmDelete(null);
  };

  return (
    <div className="space-y-2">
      {features.map((feature) => (
        <div key={feature.id} className="rounded-md border border-border bg-background p-3">
          {confirmDelete === feature.id ? (
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">
                Remove &quot;{feature.name || 'Untitled'}&quot;?
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={() => removeFeature(feature.id)}>
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-3">
                <Input
                  ref={(el) => {
                    if (el) nameInputRefs.current.set(feature.id, el);
                    else nameInputRefs.current.delete(feature.id);
                  }}
                  value={feature.name}
                  onChange={(e) => updateFeature(feature.id, { name: e.target.value })}
                  placeholder="Feature name"
                  className="flex-1 border-transparent bg-transparent text-sm hover:border-border focus:border-accent-blue"
                />
                <Select
                  value={feature.status}
                  onValueChange={(v) =>
                    updateFeature(feature.id, {
                      status: v as ProjectStatus,
                    })
                  }
                >
                  <SelectTrigger className="h-7 w-[110px] text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="planning">Planning</SelectItem>
                    <SelectItem value="in-progress">In Progress</SelectItem>
                    <SelectItem value="beta">Beta</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmDelete(feature.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="space-y-1.5">
                <div>
                  <span className="text-[10px] text-muted-foreground">AWS</span>
                  <ChipInput
                    value={feature.awsServices || []}
                    onChange={(v) => updateFeature(feature.id, { awsServices: v })}
                    suggestions={[...AWS_SERVICES]}
                    variant="aws"
                    placeholder="Add AWS service..."
                  />
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground">AI</span>
                  <ChipInput
                    value={feature.aiProviders || []}
                    onChange={(v) => updateFeature(feature.id, { aiProviders: v })}
                    suggestions={[...AI_PROVIDERS]}
                    variant="ai"
                    placeholder="Add AI provider..."
                  />
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground">Integrations</span>
                  <ChipInput
                    value={feature.integrations || []}
                    onChange={(v) => updateFeature(feature.id, { integrations: v })}
                    suggestions={[...INTEGRATIONS]}
                    variant="integration"
                    placeholder="Add integration..."
                  />
                </div>
              </div>
            </>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={addFeature}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground transition-colors hover:border-accent-blue hover:text-accent-blue"
      >
        <Plus className="h-3.5 w-3.5" /> Add Feature
      </button>
    </div>
  );
}
