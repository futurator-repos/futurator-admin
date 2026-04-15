export interface Alert {
  alertId: string;
  timestamp: string;
  projectId: string;
  type: 'cloudwatch-alarm' | 'budget-breach' | 'cost-anomaly';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  state?: string;
}
