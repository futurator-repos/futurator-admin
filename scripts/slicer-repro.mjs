import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

async function getPlan(planId) {
  const r = await ddb.send(new GetCommand({ TableName: 'futurator-plans', Key: { planId } }));
  return r.Item;
}
async function getEpic(epicId) {
  const r = await ddb.send(new GetCommand({ TableName: 'futurator-epic-workflows', Key: { epicId } }));
  return r.Item;
}
async function getJob(jobId) {
  const r = await ddb.send(new GetCommand({ TableName: 'futurator-agent-jobs', Key: { jobId } }));
  return r.Item;
}
async function getEventsForJob(jobId) {
  const all = [];
  let lastKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: 'futurator-agent-events',
      KeyConditionExpression: 'jobId = :j',
      ExpressionAttributeValues: { ':j': jobId },
      ScanIndexForward: true,
      ExclusiveStartKey: lastKey,
    }));
    all.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return all;
}

const planId = 'plan_dino-runner-1_moo8zzmz';
const plan = await getPlan(planId);
console.log('plan.status:', plan?.status, 'epicIds:', plan?.epicIds);

const jobIds = new Set();
for (const epicId of plan?.epicIds ?? []) {
  const epic = await getEpic(epicId);
  if (!epic) continue;
  if (epic.orchestratorJobId) jobIds.add(epic.orchestratorJobId);
  for (const story of epic.stories ?? []) {
    if (story.jobId) jobIds.add(story.jobId);
  }
}
console.log('jobIds count:', jobIds.size);

let totalEvents = 0, totalSlices = 0;
const summaryByJob = [];
for (const jobId of jobIds) {
  const job = await getJob(jobId);
  const events = await getEventsForJob(jobId);
  totalEvents += events.length;
  
  // Simulate sliceForJob: emit one slice per event-pair + trailing slice
  let jobSlices = 0;
  if (events.length >= 2) jobSlices = events.length - 1 + 1; // pairs + trailing
  else if (events.length === 1) jobSlices = 1;
  totalSlices += jobSlices;
  
  // Compute wall-clock: first event ts to job.updatedAt (terminal) or now (live)
  const isTerminal = ['COMPLETED','FAILED','CANCELLED'].includes(job?.status);
  const firstTs = events[0]?.timestamp;
  const lastTs = events[events.length-1]?.timestamp;
  const endTs = isTerminal ? job?.updatedAt : new Date().toISOString();
  const wallMs = firstTs ? new Date(endTs).getTime() - new Date(firstTs).getTime() : 0;
  
  summaryByJob.push({ jobId: jobId.slice(0,8), events: events.length, status: job?.status, wallMs, firstTs, lastTs, endTs });
}

console.log('total events across all 6 jobs:', totalEvents);
console.log('estimated total slices:', totalSlices);
console.log('per-job summary:');
console.log(JSON.stringify(summaryByJob, null, 2));

// What planTotalMs would be (per the API code):
// If slices.length >= 2, planTotalMs = last.endedAt - first.startedAt
// First slice startedAt is the first event timestamp of the first job (sorted by startedAt asc)
const allFirstTs = summaryByJob.map(s=>s.firstTs).filter(Boolean).sort();
const allEndTs = summaryByJob.map(s=>s.endTs).filter(Boolean).sort();
if (allFirstTs.length >= 2 && allEndTs.length >= 1) {
  const planTotalMs = new Date(allEndTs[allEndTs.length-1]).getTime() - new Date(allFirstTs[0]).getTime();
  console.log('estimated planTotalMs:', planTotalMs, '=', Math.round(planTotalMs/1000), 's');
}
