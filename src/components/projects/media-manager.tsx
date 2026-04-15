'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, X, ImageIcon, Loader2 } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api-client';
import type { ProjectMedia } from '@/types/project';

interface MediaManagerProps {
  projectId: string;
  media: ProjectMedia[];
  onChange: (media: ProjectMedia[]) => void;
}

interface UploadUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}

export function MediaManager({ projectId, media, onChange }: MediaManagerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const homepageCount = media.filter((m) => m.showOnHomepage).length;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // ── Upload via pre-signed S3 URL ──
  const uploadFile = async (file: File) => {
    if (media.length >= 6) return;
    setUploadError(null);
    setUploading(true);
    try {
      // 1. Get a pre-signed PUT URL from the API
      const presigned = await api.post<UploadUrlResponse>(`/projects/${projectId}/upload-url`, {
        filename: file.name,
        contentType: file.type,
      });
      // 2. PUT the file directly to S3
      const putResp = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResp.ok) {
        throw new Error(`S3 upload failed: ${putResp.status}`);
      }
      // 3. Add to local form state with the real public URL.
      //    Default showOnHomepage to TRUE for the first 3 uploaded items —
      //    the Zod schema caps homepage-flagged media at 3, and the expected
      //    mental model is "images uploaded to a homepage-published project
      //    should appear on the homepage by default". Users who want to
      //    exclude an image can click the blue-dot toggle to opt out.
      const currentHomepageCount = media.filter((m) => m.showOnHomepage).length;
      const newMedia: ProjectMedia = {
        id: crypto.randomUUID(),
        url: presigned.publicUrl,
        alt: file.name.replace(/\.[^.]+$/, ''),
        showOnHomepage: currentHomepageCount < 3,
        order: media.length,
      };
      onChange([...media, newMedia]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const removeMedia = (id: string) => {
    onChange(media.filter((m) => m.id !== id).map((m, i) => ({ ...m, order: i })));
    if (editingId === id) setEditingId(null);
  };

  const toggleHomepage = (id: string) => {
    const item = media.find((m) => m.id === id);
    if (!item) return;
    if (!item.showOnHomepage && homepageCount >= 3) return;
    onChange(media.map((m) => (m.id === id ? { ...m, showOnHomepage: !m.showOnHomepage } : m)));
  };

  const updateAlt = (id: string, alt: string) => {
    onChange(media.map((m) => (m.id === id ? { ...m, alt } : m)));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setUploadError('File must be PNG, JPG, or WebP');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('File must be 5MB or smaller');
      e.target.value = '';
      return;
    }
    void uploadFile(file);
    e.target.value = '';
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = media.findIndex((m) => m.id === active.id);
    const newIndex = media.findIndex((m) => m.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(media, oldIndex, newIndex).map((m, i) => ({
      ...m,
      order: i,
    }));
    onChange(reordered);
  };

  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={media.map((m) => m.id)} strategy={rectSortingStrategy}>
          <div className="flex flex-wrap gap-2">
            {media.map((m) => (
              <SortableMediaCard
                key={m.id}
                item={m}
                isEditing={editingId === m.id}
                onClick={() => setEditingId(editingId === m.id ? null : m.id)}
                onToggleHomepage={() => toggleHomepage(m.id)}
                onRemove={() => removeMedia(m.id)}
                onAltChange={(alt) => updateAlt(m.id, alt)}
                onCloseEdit={() => setEditingId(null)}
              />
            ))}
            {media.length < 6 && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex h-[72px] w-[100px] flex-col items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-accent-blue hover:text-accent-blue disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    <span className="text-[9px]">Add media</span>
                  </>
                )}
              </button>
            )}
          </div>
        </SortableContext>
      </DndContext>

      {uploadError && <p className="text-[10px] text-destructive">{uploadError}</p>}

      <p className="text-[10px] text-muted-foreground">
        Drag to reorder. Blue dot = homepage. Max 6 total, max 3 on homepage. ({media.length}/6,{' '}
        {homepageCount}/3 homepage)
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}

// ── Sortable card subcomponent ──

interface SortableCardProps {
  item: ProjectMedia;
  isEditing: boolean;
  onClick: () => void;
  onToggleHomepage: () => void;
  onRemove: () => void;
  onAltChange: (alt: string) => void;
  onCloseEdit: () => void;
}

function SortableMediaCard({
  item,
  isEditing,
  onClick,
  onToggleHomepage,
  onRemove,
  onAltChange,
  onCloseEdit,
}: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div className="relative">
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={onClick}
        className="group relative flex h-[72px] w-[100px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-md border border-border bg-muted"
      >
        {item.showOnHomepage && (
          <div className="absolute right-1 top-1 z-10 h-1.5 w-1.5 rounded-full bg-accent-blue" />
        )}
        {item.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.url}
            alt={item.alt}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="h-5 w-5 text-muted-foreground" />
        )}
        <div className="absolute inset-0 flex items-center justify-center gap-1 rounded-md bg-background/80 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation();
              onToggleHomepage();
            }}
            title={item.showOnHomepage ? 'Remove from homepage' : 'Show on homepage'}
          >
            <span className="text-xs">{item.showOnHomepage ? '\u{1F7E6}' : '\u2B1C'}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {isEditing && (
        <div className="absolute left-0 top-[78px] z-20 w-[220px] rounded-md border border-border bg-popover p-2 shadow-md">
          <label className="text-[10px] font-medium text-muted-foreground">Alt text</label>
          <input
            type="text"
            value={item.alt}
            onChange={(e) => onAltChange(e.target.value)}
            maxLength={200}
            autoFocus
            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
          />
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="xs" onClick={onCloseEdit}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
