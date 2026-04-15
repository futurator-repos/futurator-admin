import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { log } from '../shared/logger';

const ssm = new SSMClient({});
let cachedParams: { clientId: string; clientSecret: string; brokerUrl: string } | null = null;

async function getParams() {
  if (cachedParams) return cachedParams;
  const prefix = process.env.SSM_PREFIX || '/futurator-admin/prod';
  const [clientId, clientSecret, brokerUrl] = await Promise.all([
    ssm.send(
      new GetParameterCommand({
        Name: `${prefix}/IDENTITY_BROKER_CLIENT_ID`,
        WithDecryption: true,
      }),
    ),
    ssm.send(
      new GetParameterCommand({
        Name: `${prefix}/IDENTITY_BROKER_CLIENT_SECRET`,
        WithDecryption: true,
      }),
    ),
    ssm.send(
      new GetParameterCommand({ Name: `${prefix}/IDENTITY_BROKER_URL`, WithDecryption: true }),
    ),
  ]);
  cachedParams = {
    clientId: clientId.Parameter!.Value!,
    clientSecret: clientSecret.Parameter!.Value!,
    brokerUrl: brokerUrl.Parameter!.Value!,
  };
  return cachedParams;
}

export const handler = async (event: { queryStringParameters?: Record<string, string> }) => {
  const code = event.queryStringParameters?.code;
  const redirectBase = process.env.REDIRECT_BASE_URL || 'https://admin.futurator.ai';

  if (!code) {
    return { statusCode: 302, headers: { Location: `${redirectBase}/login?error=missing_code` } };
  }

  try {
    const params = await getParams();
    const correlationId = crypto.randomUUID();
    log('info', 'auth-callback', 'Exchanging OTP for tokens', { correlationId });

    // OTP codes expire in 60 seconds and are single-use — exchange immediately
    const response = await fetch(`${params.brokerUrl}/auth/oauth/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Id': 'futurator-admin',
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify({ code, clientId: params.clientId, clientSecret: params.clientSecret }),
    });

    if (!response.ok) {
      // Broker returns RFC 7807 Problem Details on error
      const brokerCorrelation = response.headers.get('X-Correlation-Id') || correlationId;
      const error = await response.json().catch(() => ({}));
      log('error', 'auth-callback', 'Token exchange failed', {
        status: response.status,
        brokerError: error.detail || error.title,
        correlationId: brokerCorrelation,
      });
      return { statusCode: 302, headers: { Location: `${redirectBase}/login?error=auth_failed` } };
    }

    // Response includes: accessToken, idToken, refreshToken, expiresIn, familyId, tokenId, user
    const data = await response.json();
    const isSecure = redirectBase.startsWith('https');
    const cookieBase = `HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Strict`;

    // Store refresh token rotation state (familyId + tokenId) in cookies
    // so the server-side refresh endpoint can use them
    // Refresh token: 30 days (per broker docs), not 7 days
    const REFRESH_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

    return {
      statusCode: 302,
      headers: {
        Location: `${redirectBase}/`,
      },
      multiValueHeaders: {
        'Set-Cookie': [
          `access_token=${data.accessToken}; Path=/; ${cookieBase}; Max-Age=3600`,
          `refresh_token=${data.refreshToken}; Path=/auth; ${cookieBase}; Max-Age=${REFRESH_MAX_AGE}`,
          `token_family=${data.familyId}; Path=/auth; ${cookieBase}; Max-Age=${REFRESH_MAX_AGE}`,
          `token_id=${data.tokenId}; Path=/auth; ${cookieBase}; Max-Age=${REFRESH_MAX_AGE}`,
        ],
      },
    };
  } catch (error) {
    log('error', 'auth-callback', 'Auth callback error', { error: String(error) });
    return { statusCode: 302, headers: { Location: `${redirectBase}/login?error=auth_failed` } };
  }
};
