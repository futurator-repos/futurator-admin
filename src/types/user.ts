export interface DirectoryUser {
  userId: string;
  email: string;
  name: string;
  projects: Record<string, { role: string; lastLogin?: string }>;
  syncedAt: string;
}
