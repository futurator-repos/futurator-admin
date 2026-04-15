// ── Project Registry — tracks deployed projects for brownfield support ──

export type ProjectStatus = 'draft' | 'active' | 'published';

export interface SessionMeta {
  sessionId: string;
  filesCreated: string[];
  filesMutated: string[];
  contextDigest: string;
  completedAt: string;
}

export interface FileManifestEntry {
  createdByStory: string;
  lastMutatedByStory: string;
  lastSessionId: string;
}

export interface ProjectRegistry {
  projectId: string; // PK — derived from app name (e.g., "spyhunter")
  name: string;
  ec2Path: string; // /home/ubuntu/projects/spyhunter
  epics: string[]; // ordered epic IDs
  currentStatus: ProjectStatus;
  deployUrl?: string;
  sessions: Record<string, SessionMeta>; // storyId → session metadata
  fileManifest: Record<string, FileManifestEntry>; // filePath → metadata
  createdAt: string;
  updatedAt: string;
}
