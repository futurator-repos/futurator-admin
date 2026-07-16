import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
} from '@aws-sdk/client-cost-explorer';
import { format, subDays } from 'date-fns';
import { putCostRecord } from '../shared/repositories/cost-repository';
import { log } from '../shared/logger';

// global service — us-east-1 endpoint only
const ce = new CostExplorerClient({ region: 'us-east-1' });

export const handler = async () => {
  const startTime = Date.now();
  const endDate = format(new Date(), 'yyyy-MM-dd');
  const startDate = format(subDays(new Date(), 90), 'yyyy-MM-dd');

  try {
    log('info', 'cost-aggregator', 'Starting cost aggregation', { startDate, endDate });

    const costResult = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: startDate, End: endDate },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [
          { Type: 'TAG', Key: 'futurator:project' },
          { Type: 'DIMENSION', Key: 'SERVICE' },
        ],
      }),
    );

    const dailyCosts = new Map<string, Map<string, Record<string, number>>>();

    for (const result of costResult.ResultsByTime || []) {
      const date = result.TimePeriod!.Start!;
      for (const group of result.Groups || []) {
        const projectTag = group.Keys?.[0]?.replace('futurator:project$', '') || 'untagged';
        const service = group.Keys?.[1] || 'Other';
        const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');

        if (!dailyCosts.has(date)) dailyCosts.set(date, new Map());
        const dateMap = dailyCosts.get(date)!;
        if (!dateMap.has(projectTag)) dateMap.set(projectTag, {});
        const breakdown = dateMap.get(projectTag)!;
        breakdown[service] = (breakdown[service] || 0) + amount;
      }
    }

    let recordCount = 0;
    for (const [date, projects] of dailyCosts) {
      let portfolioTotal = 0;
      const portfolioBreakdown: Record<string, number> = {};

      for (const [projectId, breakdown] of projects) {
        const totalAmount = Object.values(breakdown).reduce((a, b) => a + b, 0);
        portfolioTotal += totalAmount;
        for (const [svc, amt] of Object.entries(breakdown)) {
          portfolioBreakdown[svc] = (portfolioBreakdown[svc] || 0) + amt;
        }

        await putCostRecord({
          projectId,
          date,
          provider: 'aws',
          totalAmount: Math.round(totalAmount * 100) / 100,
          currency: 'USD',
          breakdown,
        });
        recordCount++;
      }

      await putCostRecord({
        projectId: 'PORTFOLIO',
        date,
        provider: 'aws',
        totalAmount: Math.round(portfolioTotal * 100) / 100,
        currency: 'USD',
        breakdown: portfolioBreakdown,
      });
      recordCount++;
    }

    // Forecast
    try {
      const forecastResult = await ce.send(
        new GetCostForecastCommand({
          TimePeriod: { Start: endDate, End: format(subDays(new Date(), -30), 'yyyy-MM-dd') },
          Metric: 'UNBLENDED_COST',
          Granularity: 'MONTHLY',
        }),
      );
      const forecastAmount = parseFloat(forecastResult.Total?.Amount || '0');
      log('info', 'cost-aggregator', 'Forecast retrieved', { forecastAmount });
    } catch (err) {
      log('warn', 'cost-aggregator', 'Forecast unavailable', { error: String(err) });
    }

    const duration = Date.now() - startTime;
    log('info', 'cost-aggregator', 'Completed', { recordCount, duration });
  } catch (error) {
    log('error', 'cost-aggregator', 'Failed', { error: String(error) });
  }
};
