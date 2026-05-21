import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { InlineQuestion } from '../types/inline-question';

export async function createInlineQuestion(q: InlineQuestion): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.partyInlineQuestions,
      Item: q,
      ConditionExpression: 'attribute_not_exists(questionId)',
    }),
  );
}

export async function getInlineQuestion(questionId: string): Promise<InlineQuestion | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.partyInlineQuestions, Key: { questionId } }),
  );
  return (result.Item as InlineQuestion) || null;
}

/**
 * List all inline questions for a session, newest-first. Uses GSI sort by
 * createdAt DESC.
 */
export async function listInlineQuestionsBySession(sessionId: string): Promise<InlineQuestion[]> {
  const out: InlineQuestion[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.partyInlineQuestions,
        IndexName: 'sessionId-createdAt-index',
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: { ':sid': sessionId },
        ScanIndexForward: false,
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as InlineQuestion[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * Story 20.10 — delete every inline question for a session, used by the
 * `DELETE /api/party/sessions/:id` cascade. Best-effort: deletes are
 * issued in parallel; the count of successfully-deleted rows is returned.
 *
 * @param sessionId
 * @returns Promise of deleted count
 */
export async function deleteBySession(sessionId: string): Promise<number> {
  const questions = await listInlineQuestionsBySession(sessionId);
  if (questions.length === 0) return 0;
  await Promise.all(
    questions.map((q) =>
      docClient.send(
        new DeleteCommand({
          TableName: TABLE_NAMES.partyInlineQuestions,
          Key: { questionId: q.questionId },
        }),
      ),
    ),
  );
  return questions.length;
}
