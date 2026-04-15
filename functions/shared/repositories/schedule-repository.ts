import {
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { Schedule } from '../types';

export async function getAllSchedules(): Promise<Schedule[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.schedules }));
  return (result.Items || []) as Schedule[];
}

export async function getScheduleById(scheduleId: string): Promise<Schedule | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.schedules, Key: { scheduleId } }),
  );
  return (result.Item as Schedule) || null;
}

export async function createSchedule(schedule: Schedule): Promise<Schedule> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.schedules, Item: schedule }));
  return schedule;
}

export async function updateSchedule(
  scheduleId: string,
  updates: Partial<Schedule>,
): Promise<Schedule> {
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined && key !== 'scheduleId') {
      expressions.push(`#${key} = :${key}`);
      names[`#${key}`] = key;
      values[`:${key}`] = value;
    }
  });

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.schedules,
      Key: { scheduleId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return result.Attributes as Schedule;
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAMES.schedules, Key: { scheduleId } }),
  );
}
