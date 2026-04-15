export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuditResult {
  projectId: string;
  auditDate: string;
  tagComplianceScore: number;
  totalResources: number;
  compliantResources: number;
  issues?: AuditIssue[];
}

export interface AuditIssue {
  rule: string;
  resource: string;
  severity: 'critical' | 'warning' | 'info';
  detail: string;
}
