export interface Schedule {
  scheduleId: string;
  resourceType: 'ec2' | 'ecs';
  resourceId: string;
  projectId: string;
  action: 'start' | 'stop';
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  lastExecution?: { time: string; result: 'success' | 'failure' };
}
