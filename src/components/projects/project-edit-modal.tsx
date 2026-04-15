'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DescriptionField } from '@/components/projects/description-field';
import { ChipInput } from '@/components/projects/chip-input';
import { FeatureEditor } from '@/components/projects/feature-editor';
import { MediaManager } from '@/components/projects/media-manager';
import { useProject, useUpdateProject, useProjects } from '@/hooks/use-projects';
import { CATEGORY_LABELS } from '@/lib/constants';
import { ChevronDownIcon, Loader2Icon } from 'lucide-react';
import type {
  Project,
  ProjectStatus,
  ProjectCategory,
  ProjectDescriptions,
  ProjectMedia,
  Feature,
} from '@/types/project';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectEditModalProps {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FormData {
  name: string;
  status: ProjectStatus;
  category: ProjectCategory;
  publishedToHomepage: boolean;
  homepageOrder: number;
  descriptions: ProjectDescriptions;
  features: Feature[];
  media: ProjectMedia[];
  team: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: 'planning', label: 'Planning' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'beta', label: 'Beta' },
  { value: 'active', label: 'Active' },
];

const CATEGORY_OPTIONS: { value: ProjectCategory; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'independent-companies', label: CATEGORY_LABELS['independent-companies'] },
  { value: 'joint-venture', label: CATEGORY_LABELS['joint-venture'] },
  { value: 'shared-infra', label: CATEGORY_LABELS['shared-infra'] },
];

function buildFormData(project: Project): FormData {
  // Defensive defaults: legacy projects (pre-Story-10-2) or any project written
  // before the data migration may be missing `descriptions`, `homepageFlags`,
  // `media`, `publishedToHomepage`, etc. We always return a complete shape so
  // every downstream consumer (validate, isFormDirty, JSX) can rely on
  // non-undefined nested fields.
  const d = project.descriptions || {};
  const flags = d.homepageFlags || { headline: false, brief: false, summary: false };
  return {
    name: project.name,
    status: project.status,
    category: project.category,
    publishedToHomepage: project.publishedToHomepage ?? false,
    homepageOrder: project.homepageOrder ?? 0,
    descriptions: {
      headline: d.headline ?? '',
      brief: d.brief ?? '',
      summary: d.summary ?? '',
      full: d.full ?? '',
      aiContext: d.aiContext ?? '',
      homepageFlags: {
        headline: flags.headline ?? false,
        brief: flags.brief ?? false,
        summary: flags.summary ?? false,
      },
    },
    features: (project.features || []).map((f) => ({
      ...f,
      awsServices: [...(f.awsServices || [])],
      aiProviders: [...(f.aiProviders || [])],
      integrations: [...(f.integrations || [])],
    })),
    media: (project.media || []).map((m) => ({ ...m })),
    team: [...(project.team || [])],
  };
}

function mediaEqual(a: ProjectMedia[], b: ProjectMedia[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ma = a[i];
    const mb = b[i];
    if (
      ma.id !== mb.id ||
      ma.url !== mb.url ||
      ma.alt !== mb.alt ||
      ma.showOnHomepage !== mb.showOnHomepage ||
      ma.order !== mb.order
    )
      return false;
  }
  return true;
}

function featuresEqual(a: Feature[], b: Feature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const fa = a[i];
    const fb = b[i];
    if (fa.id !== fb.id) return false;
    if (fa.name !== fb.name) return false;
    if (fa.status !== fb.status) return false;
    const arrEq = (x: string[] = [], y: string[] = []) =>
      x.length === y.length && x.every((v, j) => v === y[j]);
    if (!arrEq(fa.awsServices, fb.awsServices)) return false;
    if (!arrEq(fa.aiProviders, fb.aiProviders)) return false;
    if (!arrEq(fa.integrations, fb.integrations)) return false;
  }
  return true;
}

function isFormDirty(form: FormData, initial: FormData): boolean {
  if (form.name !== initial.name) return true;
  if (form.status !== initial.status) return true;
  if (form.category !== initial.category) return true;
  if (form.publishedToHomepage !== initial.publishedToHomepage) return true;
  if (form.homepageOrder !== initial.homepageOrder) return true;

  const d = form.descriptions;
  const id = initial.descriptions;
  if (d.headline !== id.headline) return true;
  if (d.brief !== id.brief) return true;
  if (d.summary !== id.summary) return true;
  if (d.full !== id.full) return true;
  if (d.aiContext !== id.aiContext) return true;
  if (d.homepageFlags.headline !== id.homepageFlags.headline) return true;
  if (d.homepageFlags.brief !== id.homepageFlags.brief) return true;
  if (d.homepageFlags.summary !== id.homepageFlags.summary) return true;

  if (form.team.length !== initial.team.length) return true;
  if (form.team.some((t, i) => t !== initial.team[i])) return true;

  if (!featuresEqual(form.features, initial.features)) return true;
  if (!mediaEqual(form.media, initial.media)) return true;

  return false;
}

interface ValidationErrors {
  name?: string;
  descriptions?: Partial<Record<keyof ProjectDescriptions, string>>;
}

function validate(form: FormData): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!form.name.trim()) {
    errors.name = 'Name is required';
  } else if (form.name.length > 100) {
    errors.name = 'Name must be 100 characters or fewer';
  }

  const descErrors: Partial<Record<string, string>> = {};
  if (form.descriptions.headline.length > 60) descErrors.headline = 'Max 60 characters';
  if (form.descriptions.brief.length > 140) descErrors.brief = 'Max 140 characters';
  if (form.descriptions.summary.length > 300) descErrors.summary = 'Max 300 characters';
  if (form.descriptions.full.length > 1000) descErrors.full = 'Max 1000 characters';
  if (form.descriptions.aiContext.length > 2000) descErrors.aiContext = 'Max 2000 characters';

  if (form.publishedToHomepage) {
    if (!form.descriptions.headline.trim())
      descErrors.headline = 'Headline required when published';
    if (!form.descriptions.brief.trim()) descErrors.brief = 'Brief required when published';
  }

  if (Object.keys(descErrors).length > 0) {
    errors.descriptions = descErrors;
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Section header component
// ---------------------------------------------------------------------------

function SectionHeader({ title, open }: { title: string; open: boolean }) {
  return (
    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors">
      <span>{title}</span>
      <ChevronDownIcon
        className={`size-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
      />
    </CollapsibleTrigger>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProjectEditModal({ projectId, open, onOpenChange }: ProjectEditModalProps) {
  const { data: project, isLoading } = useProject(projectId ?? '');
  const { data: projects } = useProjects();
  const updateProject = useUpdateProject(projectId ?? '');

  // Derive all team member suggestions from all projects
  const allTeamMembers = useMemo(
    () => Array.from(new Set(projects?.flatMap((p) => p.team) || [])),
    [projects],
  );

  // Section open/close states
  const [identityOpen, setIdentityOpen] = useState(true);
  const [descriptionsOpen, setDescriptionsOpen] = useState(true);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);

  // Form state
  const [formData, setFormData] = useState<FormData | null>(null);
  const [initialData, setInitialData] = useState<FormData | null>(null);

  // Validation / save state
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);

  // Discard confirmation
  const [discardOpen, setDiscardOpen] = useState(false);

  // Track previous prop values to detect changes during render.
  // Using state (not refs) because the React Compiler forbids ref access during render.
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevProject, setPrevProject] = useState(project);

  if (open !== prevOpen || project !== prevProject) {
    const wasOpen = prevOpen;
    setPrevOpen(open);
    setPrevProject(project);

    // Reset on close
    if (!open && wasOpen) {
      setFormData(null);
      setInitialData(null);
      setErrors({});
      setApiError(null);
      setSavedAt(null);
      setSaveFlash(false);
      setIdentityOpen(true);
      setDescriptionsOpen(true);
      setMediaOpen(false);
      setFeaturesOpen(false);
      setTeamOpen(false);
    }

    // Initialize form data when project loads or dialog opens
    if (project && open) {
      const data = buildFormData(project);
      setFormData(data);
      setInitialData(buildFormData(project));
      setErrors({});
      setApiError(null);
      setSavedAt(null);
    }
  }

  const dirty = useMemo(
    () => (formData && initialData ? isFormDirty(formData, initialData) : false),
    [formData, initialData],
  );

  // ---- Form field updaters ----

  const updateField = useCallback(<K extends keyof FormData>(key: K, value: FormData[K]) => {
    setFormData((prev) => (prev ? { ...prev, [key]: value } : prev));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }, []);

  const updateDescription = useCallback(
    <K extends keyof ProjectDescriptions>(key: K, value: ProjectDescriptions[K]) => {
      setFormData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          descriptions: { ...prev.descriptions, [key]: value },
        };
      });
      setErrors((prev) => {
        if (!prev.descriptions) return prev;
        const updated = { ...prev.descriptions };
        delete updated[key];
        return { ...prev, descriptions: Object.keys(updated).length > 0 ? updated : undefined };
      });
    },
    [],
  );

  const updateHomepageFlag = useCallback(
    (key: keyof ProjectDescriptions['homepageFlags'], value: boolean) => {
      setFormData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          descriptions: {
            ...prev.descriptions,
            homepageFlags: { ...prev.descriptions.homepageFlags, [key]: value },
          },
        };
      });
    },
    [],
  );

  // ---- Auto-generate AI Context ----

  const generateAiContext = useCallback(() => {
    if (!formData || !project) return;

    const parts: string[] = [];
    parts.push(`${formData.name} is a ${formData.category.replace(/-/g, ' ')} project`);
    if (formData.descriptions.brief) {
      parts[0] += `: ${formData.descriptions.brief}`;
    }
    parts[0] += '.';

    if (project.features.length > 0) {
      parts.push(`Key features: ${project.features.map((f) => f.name).join(', ')}.`);
    }

    parts.push(`Status: ${formData.status}.`);

    if (project.awsServices.length > 0) {
      parts.push(`AWS: ${project.awsServices.join(', ')}.`);
    }

    const allAiProviders = [...new Set(project.features.flatMap((f) => f.aiProviders))];
    if (allAiProviders.length > 0) {
      parts.push(`AI: ${allAiProviders.join(', ')}.`);
    }

    const allIntegrations = [...new Set(project.features.flatMap((f) => f.integrations))];
    if (allIntegrations.length > 0) {
      parts.push(`Integrations: ${allIntegrations.join(', ')}.`);
    }

    const generated = parts.join(' ');
    updateDescription('aiContext', generated);
  }, [formData, project, updateDescription]);

  const handleAutoGenerate = useCallback(() => {
    if (!formData) return;
    if (formData.descriptions.aiContext.trim()) {
      if (!window.confirm('Overwrite existing AI Context?')) return;
    }
    generateAiContext();
  }, [formData, generateAiContext]);

  // ---- Save ----

  const handleSave = useCallback(async () => {
    if (!formData || !projectId) return;

    const validationErrors = validate(formData);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setApiError(null);
    setErrors({});

    try {
      await updateProject.mutateAsync({
        name: formData.name,
        status: formData.status,
        category: formData.category,
        publishedToHomepage: formData.publishedToHomepage,
        homepageOrder: formData.homepageOrder,
        descriptions: formData.descriptions,
        features: formData.features,
        media: formData.media,
        team: formData.team,
      });

      // Success
      setInitialData({
        ...formData,
        descriptions: {
          ...formData.descriptions,
          homepageFlags: { ...formData.descriptions.homepageFlags },
        },
        features: formData.features.map((f) => ({
          ...f,
          awsServices: [...(f.awsServices || [])],
          aiProviders: [...(f.aiProviders || [])],
          integrations: [...(f.integrations || [])],
        })),
        media: formData.media.map((m) => ({ ...m })),
        team: [...formData.team],
      });
      const now = new Date();
      setSavedAt(
        `Saved at ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`,
      );
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 1500);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Save failed. Please try again.');
    }
  }, [formData, projectId, updateProject]);

  // ---- Close handling ----

  const handleRequestClose = useCallback(
    (nextOpen?: boolean) => {
      // When called from Dialog's onOpenChange, nextOpen will be false
      if (nextOpen === true) return;
      if (dirty) {
        setDiscardOpen(true);
      } else {
        onOpenChange(false);
      }
    },
    [dirty, onOpenChange],
  );

  const handleConfirmDiscard = useCallback(() => {
    setDiscardOpen(false);
    onOpenChange(false);
  }, [onOpenChange]);

  // ---- Render ----

  if (!projectId) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleRequestClose} disablePointerDismissal>
        <DialogContent
          className="sm:max-w-[800px] max-h-[85vh] flex flex-col p-0"
          showCloseButton={false}
        >
          {/* Header */}
          <DialogHeader className="shrink-0 px-6 pt-5 pb-3 border-b">
            <div className="flex items-center justify-between">
              <DialogTitle className="font-light text-xl">
                Edit Project: {project?.name ?? '...'}
              </DialogTitle>
              <Button variant="ghost" size="icon-sm" onClick={() => handleRequestClose()}>
                <span className="sr-only">Close</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </Button>
            </div>
          </DialogHeader>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1">
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {apiError && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-3">
                {apiError}
              </div>
            )}

            {formData && (
              <>
                {/* ── Identity Section ── */}
                <Collapsible open={identityOpen} onOpenChange={(val) => setIdentityOpen(val)}>
                  <SectionHeader title="Identity" open={identityOpen} />
                  <CollapsibleContent>
                    <div className="space-y-4 px-3 pb-4 pt-2">
                      {/* Name */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-medium text-muted-foreground">Name</label>
                          <span
                            className={`text-[10px] font-mono ${formData.name.length > 100 ? 'text-destructive' : formData.name.length >= 90 ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground'}`}
                            aria-live="polite"
                          >
                            {formData.name.length}/100
                          </span>
                        </div>
                        <Input
                          value={formData.name}
                          onChange={(e) => updateField('name', e.target.value)}
                          placeholder="Project name"
                          className="text-sm"
                          aria-invalid={!!errors.name}
                          autoFocus
                        />
                        {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
                      </div>

                      {/* Status */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Status</label>
                        <Select
                          value={formData.status}
                          onValueChange={(val) => updateField('status', val as ProjectStatus)}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Category */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">
                          Category
                        </label>
                        <Select
                          value={formData.category}
                          onValueChange={(val) => updateField('category', val as ProjectCategory)}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CATEGORY_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Published to Homepage */}
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-muted-foreground">
                          Published to Homepage
                        </label>
                        <Switch
                          checked={formData.publishedToHomepage}
                          onCheckedChange={(checked) => updateField('publishedToHomepage', checked)}
                        />
                      </div>

                      {/* Homepage Order (visible only when published) */}
                      {formData.publishedToHomepage && (
                        <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                          <label className="text-xs font-medium text-muted-foreground">
                            Homepage Order
                          </label>
                          <Input
                            type="number"
                            min={0}
                            value={formData.homepageOrder}
                            onChange={(e) =>
                              updateField('homepageOrder', parseInt(e.target.value, 10) || 0)
                            }
                            className="w-24 text-sm"
                          />
                        </div>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* ── Descriptions Section ── */}
                <Collapsible
                  open={descriptionsOpen}
                  onOpenChange={(val) => setDescriptionsOpen(val)}
                >
                  <SectionHeader title="Descriptions" open={descriptionsOpen} />
                  <CollapsibleContent>
                    <div className="space-y-4 px-3 pb-4 pt-2">
                      <DescriptionField
                        label="Headline"
                        value={formData.descriptions.headline}
                        onChange={(v) => updateDescription('headline', v)}
                        maxLength={60}
                        showHomepageFlag
                        homepageFlagged={formData.descriptions.homepageFlags.headline}
                        onHomepageFlagChange={(c) => updateHomepageFlag('headline', c)}
                        placeholder="Short headline for the project"
                      />
                      {errors.descriptions?.headline && (
                        <p className="text-xs text-destructive -mt-2">
                          {errors.descriptions.headline}
                        </p>
                      )}

                      <DescriptionField
                        label="Brief"
                        value={formData.descriptions.brief}
                        onChange={(v) => updateDescription('brief', v)}
                        maxLength={140}
                        showHomepageFlag
                        homepageFlagged={formData.descriptions.homepageFlags.brief}
                        onHomepageFlagChange={(c) => updateHomepageFlag('brief', c)}
                        placeholder="One-liner description"
                      />
                      {errors.descriptions?.brief && (
                        <p className="text-xs text-destructive -mt-2">
                          {errors.descriptions.brief}
                        </p>
                      )}

                      <DescriptionField
                        label="Summary"
                        value={formData.descriptions.summary}
                        onChange={(v) => updateDescription('summary', v)}
                        maxLength={300}
                        multiline
                        rows={2}
                        showHomepageFlag
                        homepageFlagged={formData.descriptions.homepageFlags.summary}
                        onHomepageFlagChange={(c) => updateHomepageFlag('summary', c)}
                        placeholder="A brief summary"
                      />
                      {errors.descriptions?.summary && (
                        <p className="text-xs text-destructive -mt-2">
                          {errors.descriptions.summary}
                        </p>
                      )}

                      <DescriptionField
                        label="Full"
                        value={formData.descriptions.full}
                        onChange={(v) => updateDescription('full', v)}
                        maxLength={1000}
                        multiline
                        rows={3}
                        placeholder="Full project description"
                      />
                      {errors.descriptions?.full && (
                        <p className="text-xs text-destructive -mt-2">{errors.descriptions.full}</p>
                      )}

                      <div className="space-y-1.5">
                        <DescriptionField
                          label="AI Context"
                          value={formData.descriptions.aiContext}
                          onChange={(v) => updateDescription('aiContext', v)}
                          maxLength={2000}
                          multiline
                          rows={3}
                          placeholder="Context for AI assistants"
                        />
                        {errors.descriptions?.aiContext && (
                          <p className="text-xs text-destructive">
                            {errors.descriptions.aiContext}
                          </p>
                        )}
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={handleAutoGenerate}
                          type="button"
                        >
                          Auto-generate
                        </Button>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* ── Media Section ── */}
                <Collapsible open={mediaOpen} onOpenChange={(val) => setMediaOpen(val)}>
                  <SectionHeader title={`Media (${formData.media.length} of 6)`} open={mediaOpen} />
                  <CollapsibleContent>
                    <div className="px-3 pb-4 pt-2">
                      {projectId && (
                        <MediaManager
                          projectId={projectId}
                          media={formData.media}
                          onChange={(media) =>
                            setFormData((prev) => (prev ? { ...prev, media } : prev))
                          }
                        />
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* ── Features Section ── */}
                <Collapsible open={featuresOpen} onOpenChange={(val) => setFeaturesOpen(val)}>
                  <SectionHeader
                    title={`Features & Services (${formData.features.length})`}
                    open={featuresOpen}
                  />
                  <CollapsibleContent>
                    <div className="px-3 pb-4 pt-2">
                      <FeatureEditor
                        features={formData.features}
                        onChange={(features) =>
                          setFormData((prev) => (prev ? { ...prev, features } : prev))
                        }
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* ── Team Section ── */}
                <Collapsible open={teamOpen} onOpenChange={(val) => setTeamOpen(val)}>
                  <SectionHeader title={`Team (${formData.team.length})`} open={teamOpen} />
                  <CollapsibleContent>
                    <div className="px-3 pb-4 pt-2">
                      <ChipInput
                        value={formData.team}
                        onChange={(team) =>
                          setFormData((prev) => (prev ? { ...prev, team } : prev))
                        }
                        suggestions={allTeamMembers}
                        variant="default"
                        placeholder="Add team member..."
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}
          </div>

          {/* Footer */}
          <DialogFooter className="shrink-0 px-6 py-3 flex-row items-center justify-between sm:justify-between">
            <span className="text-xs text-muted-foreground">{savedAt ?? ''}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => handleRequestClose()}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={!dirty || updateProject.isPending}
                className={`min-w-[110px] transition-colors ${saveFlash ? 'bg-success hover:bg-success text-primary-foreground' : ''}`}
              >
                {updateProject.isPending ? (
                  <>
                    <Loader2Icon className="size-4 animate-spin mr-1" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discard confirmation dialog */}
      <AlertDialog open={discardOpen} onOpenChange={(val) => setDiscardOpen(val)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>You have unsaved changes. Discard them?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDiscardOpen(false)}>
              Keep Editing
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDiscard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
