'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Project, ProjectStatus, ProjectCategory } from '@/types/project';

const triggerClass =
  'inline-flex h-8 items-center justify-between rounded-md border border-input bg-background px-3 text-xs font-normal text-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

interface FilterBarProps {
  projects: Project[];
  onFilteredChange: (filtered: Project[]) => void;
}

type SortKey = 'name-asc' | 'name-desc' | 'status' | 'category' | 'updated' | 'homepage-order';

type PublishedFilter = 'all' | 'published' | 'not-published';

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: 'planning', label: 'Planning' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'beta', label: 'Beta' },
  { value: 'active', label: 'Active' },
];

const CATEGORY_OPTIONS: { value: ProjectCategory; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'independent-companies', label: 'Independent' },
  { value: 'joint-venture', label: 'Joint Venture' },
  { value: 'shared-infra', label: 'Shared Infra' },
];

export function FilterBar({ projects, onFilteredChange }: FilterBarProps) {
  const [statusFilter, setStatusFilter] = useState<Set<ProjectStatus>>(() => new Set());
  const [categoryFilter, setCategoryFilter] = useState<Set<ProjectCategory>>(() => new Set());
  const [publishedFilter, setPublishedFilter] = useState<PublishedFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name-asc');

  const filtered = useMemo(() => {
    let result = [...projects];

    if (statusFilter.size > 0) result = result.filter((p) => statusFilter.has(p.status));
    if (categoryFilter.size > 0) result = result.filter((p) => categoryFilter.has(p.category));
    if (publishedFilter === 'published') result = result.filter((p) => p.publishedToHomepage);
    if (publishedFilter === 'not-published') result = result.filter((p) => !p.publishedToHomepage);

    result.sort((a, b) => {
      switch (sortKey) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'status':
          return a.status.localeCompare(b.status);
        case 'category':
          return a.category.localeCompare(b.category);
        case 'updated':
          return (b.updatedAt || '').localeCompare(a.updatedAt || '');
        case 'homepage-order':
          return (a.homepageOrder ?? 0) - (b.homepageOrder ?? 0);
        default:
          return 0;
      }
    });

    return result;
  }, [projects, statusFilter, categoryFilter, publishedFilter, sortKey]);

  // Notify the parent AFTER render rather than during the useMemo body, which
  // would trigger a "setState during render" warning in React 19. The parent
  // owns the filtered state for header counting, so we sync it via effect.
  useEffect(() => {
    onFilteredChange(filtered);
  }, [filtered, onFilteredChange]);

  const toggleStatus = useCallback((value: ProjectStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((value: ProjectCategory) => {
    setCategoryFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  const removeStatus = useCallback((value: ProjectStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      next.delete(value);
      return next;
    });
  }, []);

  const removeCategory = useCallback((value: ProjectCategory) => {
    setCategoryFilter((prev) => {
      const next = new Set(prev);
      next.delete(value);
      return next;
    });
  }, []);

  // Build active-filter chips: one per selected status/category, plus published
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  STATUS_OPTIONS.forEach((opt) => {
    if (statusFilter.has(opt.value)) {
      activeFilters.push({
        key: `status-${opt.value}`,
        label: `Status: ${opt.label}`,
        clear: () => removeStatus(opt.value),
      });
    }
  });
  CATEGORY_OPTIONS.forEach((opt) => {
    if (categoryFilter.has(opt.value)) {
      activeFilters.push({
        key: `category-${opt.value}`,
        label: `Category: ${opt.label}`,
        clear: () => removeCategory(opt.value),
      });
    }
  });
  if (publishedFilter !== 'all') {
    activeFilters.push({
      key: 'published',
      label: `Published: ${publishedFilter === 'published' ? 'Yes' : 'No'}`,
      clear: () => setPublishedFilter('all'),
    });
  }

  const hasFilters = activeFilters.length > 0;

  const clearAllFilters = () => {
    setStatusFilter(new Set());
    setCategoryFilter(new Set());
    setPublishedFilter('all');
  };

  const statusTriggerLabel =
    statusFilter.size === 0
      ? 'Status: All'
      : statusFilter.size === 1
        ? `Status: ${STATUS_OPTIONS.find((o) => statusFilter.has(o.value))?.label}`
        : `Status: ${statusFilter.size} selected`;

  const categoryTriggerLabel =
    categoryFilter.size === 0
      ? 'Category: All'
      : categoryFilter.size === 1
        ? `Category: ${CATEGORY_OPTIONS.find((o) => categoryFilter.has(o.value))?.label}`
        : `Category: ${categoryFilter.size} selected`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Status multi-select */}
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(triggerClass, 'w-[160px]')}>
            <span className="truncate">{statusTriggerLabel}</span>
            <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[160px]">
            {STATUS_OPTIONS.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt.value}
                checked={statusFilter.has(opt.value)}
                closeOnClick={false}
                onCheckedChange={() => toggleStatus(opt.value)}
              >
                {opt.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Category multi-select */}
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(triggerClass, 'w-[180px]')}>
            <span className="truncate">{categoryTriggerLabel}</span>
            <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[180px]">
            {CATEGORY_OPTIONS.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt.value}
                checked={categoryFilter.has(opt.value)}
                closeOnClick={false}
                onCheckedChange={() => toggleCategory(opt.value)}
              >
                {opt.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Published single-select */}
        <Select
          value={publishedFilter}
          onValueChange={(v) => {
            if (v != null) setPublishedFilter(v as PublishedFilter);
          }}
        >
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Published: All</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="not-published">Not Published</SelectItem>
          </SelectContent>
        </Select>

        {/* Sort */}
        <div className="ml-auto">
          <Select
            value={sortKey}
            onValueChange={(v) => {
              if (v != null) setSortKey(v as SortKey);
            }}
          >
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name-asc">Sort: Name A-Z</SelectItem>
              <SelectItem value="name-desc">Sort: Name Z-A</SelectItem>
              <SelectItem value="status">Sort: Status</SelectItem>
              <SelectItem value="category">Sort: Category</SelectItem>
              <SelectItem value="updated">Sort: Last Updated</SelectItem>
              <SelectItem value="homepage-order">Sort: Homepage Order</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {hasFilters && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeFilters.map((f) => (
            <span
              key={f.key}
              className="inline-flex items-center gap-1 rounded-full border border-accent-blue/30 bg-accent-blue/10 px-2.5 py-0.5 text-[11px] text-accent-blue"
            >
              {f.label}
              <button
                onClick={f.clear}
                className="opacity-70 hover:opacity-100"
                aria-label={`Remove ${f.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {filtered.length === 0 && hasFilters && (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">No projects match your filters</p>
          <Button variant="outline" size="sm" onClick={clearAllFilters}>
            Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}
