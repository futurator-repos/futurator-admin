export type ProjectStatus = 'draft' | 'active' | 'published';

export interface SessionMeta {
  sessionId: string;
  filesCreated: string[];
  filesMutated: string[];
  contextDigest: string;
  completedAt: string;
}

export interface ProjectRegistry {
  projectId: string;
  name: string;
  ec2Path: string;
  epics: string[];
  currentStatus: ProjectStatus;
  deployUrl?: string;
  sessions: Record<string, SessionMeta>;
  fileManifest: Record<
    string,
    { createdByStory: string; lastMutatedByStory: string; lastSessionId: string }
  >;
  createdAt: string;
  updatedAt: string;
}
