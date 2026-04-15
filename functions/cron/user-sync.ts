import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { putUser } from '../shared/repositories/user-repository';
import { log } from '../shared/logger';

const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1' });
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_djPwzFjUe';

export const handler = async () => {
  const startTime = Date.now();
  let userCount = 0;

  try {
    let paginationToken: string | undefined;
    do {
      const result = await cognito.send(
        new ListUsersCommand({
          UserPoolId: USER_POOL_ID,
          Limit: 60,
          PaginationToken: paginationToken,
        }),
      );

      for (const user of result.Users || []) {
        const attrs: Record<string, string> = {};
        for (const attr of user.Attributes || []) {
          attrs[attr.Name!] = attr.Value!;
        }

        await putUser({
          userId: user.Username!,
          email: attrs.email || '',
          name: attrs.name || attrs.email || user.Username!,
          projects: {},
          syncedAt: new Date().toISOString(),
        });
        userCount++;
      }

      paginationToken = result.PaginationToken;
    } while (paginationToken);

    log('info', 'user-sync', 'Completed', { userCount, duration: Date.now() - startTime });
  } catch (error) {
    log('error', 'user-sync', 'Failed', { error: String(error) });
  }
};
