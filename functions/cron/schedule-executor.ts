import { EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { updateSchedule } from '../shared/repositories/schedule-repository';
import { log } from '../shared/logger';

const ec2 = new EC2Client({});
const ecs = new ECSClient({});

interface ScheduleEvent {
  scheduleId: string;
  resourceType: 'ec2' | 'ecs';
  resourceId: string;
  projectId: string;
  action: 'start' | 'stop';
}

export const handler = async (event: ScheduleEvent) => {
  const { scheduleId, resourceType, resourceId, action } = event;
  log('info', 'schedule-executor', 'Executing schedule', { ...event });

  try {
    if (resourceType === 'ec2') {
      if (action === 'start') {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [resourceId] }));
      } else {
        await ec2.send(new StopInstancesCommand({ InstanceIds: [resourceId] }));
      }
    } else if (resourceType === 'ecs') {
      if (action === 'start') {
        await ecs.send(
          new RunTaskCommand({
            cluster: 'applicator-staging',
            taskDefinition: resourceId,
            launchType: 'FARGATE',
            count: 1,
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: ['subnet-0b85dc11fb0285693', 'subnet-08786859267def985'],
                assignPublicIp: 'ENABLED',
              },
            },
          }),
        );
      } else {
        const tasks = await ecs.send(
          new DescribeTasksCommand({ cluster: 'applicator-staging', tasks: [resourceId] }),
        );
        for (const task of tasks.tasks || []) {
          if (task.taskArn) {
            await ecs.send(
              new StopTaskCommand({ cluster: 'applicator-staging', task: task.taskArn }),
            );
          }
        }
      }
    }

    await updateSchedule(scheduleId, {
      lastExecution: { time: new Date().toISOString(), result: 'success' },
    });

    log('info', 'schedule-executor', 'Completed', { scheduleId, action, resourceType });
  } catch (error) {
    await updateSchedule(scheduleId, {
      lastExecution: { time: new Date().toISOString(), result: 'failure' },
    });
    log('error', 'schedule-executor', 'Failed', { scheduleId, error: String(error) });
  }
};
