'use client';

import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { ProjectListRow, ProjectListRowSkeleton } from '@/components/projects/project-list-row';
import { FilterBar } from '@/components/projects/filter-bar';
import { ProjectEditModal } from '@/components/projects/project-edit-modal';
import { useProjects } from '@/hooks/use-projects';
import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
import type { Project } from '@/types/project';

export default function ProjectsPage() {
  const { data: projects, isLoading } = useProjects();
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [filteredProjects, setFilteredProjects] = useState<Project[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const handleFilteredChange = useCallback((filtered: Project[]) => {
    setFilteredProjects(filtered);
  }, []);

  const totalCount = projects?.length ?? 0;
  const filteredCount = filteredProjects.length;
  const isFiltered = totalCount !== filteredCount && !isLoading && projects;

  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-page-title">
              Projects{' '}
              {projects && (
                <span className="text-sm font-normal text-muted-foreground">
                  {isFiltered ? `(${filteredCount} of ${totalCount})` : `(${totalCount})`}
                </span>
              )}
            </h1>
            <Button
              onClick={() => setShowCreate(true)}
              className="bg-accent-blue text-white hover:bg-accent-blue/90"
            >
              <Plus className="mr-1.5 h-4 w-4" /> Create Project
            </Button>
          </div>

          {!isLoading && projects && (
            <FilterBar projects={projects} onFilteredChange={handleFilteredChange} />
          )}

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {/* Header */}
            <div className="grid grid-cols-[120px_1fr_90px_100px_1.2fr_44px_44px] items-center gap-2 border-b border-border bg-card px-4 py-2.5">
              <span className="text-badge uppercase text-muted-foreground">Media</span>
              <span className="text-badge uppercase text-muted-foreground">Project</span>
              <span className="text-badge uppercase text-muted-foreground">Status</span>
              <span className="text-badge uppercase text-muted-foreground">Category</span>
              <span className="text-badge uppercase text-muted-foreground">Brief</span>
              <span className="text-center text-badge uppercase text-muted-foreground">Pub</span>
              <span className="text-center text-badge uppercase text-muted-foreground">Edit</span>
            </div>

            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => <ProjectListRowSkeleton key={i} />)
              : filteredProjects.length > 0
                ? filteredProjects.map((project) => (
                    <ProjectListRow
                      key={project.projectId}
                      project={project}
                      onEdit={(id) => setEditingProjectId(id)}
                    />
                  ))
                : null}
          </div>
        </div>

        {/* Edit Project Modal */}
        <ProjectEditModal
          projectId={editingProjectId}
          open={!!editingProjectId}
          onOpenChange={(open) => {
            if (!open) setEditingProjectId(null);
          }}
        />

        {/* Create Project Dialog */}
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle className="text-modal-title">Create New Project</DialogTitle>
              <DialogDescription>
                Project creation requires infrastructure provisioning, cost tracking setup, and
                service registration. This capability is coming in a future update.
              </DialogDescription>
            </DialogHeader>
            <div className="pointer-events-none space-y-4 opacity-50">
              <div className="space-y-2">
                <label className="text-label text-muted-foreground">Name</label>
                <div className="h-9 rounded-md border border-border bg-muted" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-label text-muted-foreground">Status</label>
                  <div className="h-9 rounded-md border border-border bg-muted" />
                </div>
                <div className="space-y-2">
                  <label className="text-label text-muted-foreground">Category</label>
                  <div className="h-9 rounded-md border border-border bg-muted" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-label text-muted-foreground">Descriptions</label>
                <div className="h-24 rounded-md border border-border bg-muted" />
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </AppShell>
    </AuthGuard>
  );
}
