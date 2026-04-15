export interface CostRecord {
  projectId: string;
  date: string;
  provider: string;
  totalAmount: number;
  currency: string;
  breakdown: Record<string, number>;
  forecast?: { endOfMonth: number; confidence: 'low' | 'medium' | 'high' };
  anomalies?: CostAnomaly[];
}

export interface CostAnomaly {
  service: string;
  amount: number;
  expectedAmount: number;
  severity: 'low' | 'medium' | 'high';
}

export interface CostOverview {
  totalMonthly: number;
  currency: string;
  period: string;
  projects: ProjectCostSummary[];
  topServices: ServiceCost[];
}

export interface ProjectCostSummary {
  projectId: string;
  amount: number;
  trend: 'up' | 'down' | 'flat';
  changePercent: number;
}

export interface ServiceCost {
  service: string;
  amount: number;
}

export interface CostForecast {
  projectId: string;
  endOfMonth: number;
  confidence: 'low' | 'medium' | 'high';
}
