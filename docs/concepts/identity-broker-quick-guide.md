# Identity Broker Quick Guide

> Single source of truth for setting up and consuming the Identity Broker.
> Every endpoint and feature described here exists in the codebase and is verified.

---

## Architecture Overview

```
App Agent                     Identity Broker (AWS Lambda + API Gateway)
   │                                    │
   ├── POST /apps/register ────────────→│ Register app (API key auth)
   │   ← Complete integration info ─────│
   │                                    │
   ├── GET /auth/oauth/google?appId= ──→│ OAuth initiate
   │   ← 302 redirect to Google ────────│
   │                                    │
   ├── POST /auth/oauth/exchange ──────→│ Exchange OTP for JWT
   │   ← {accessToken, idToken, ...} ──│
   │                                    │
   └── GET /auth/profile ─────────────→│ Protected endpoint
       ← User profile ─────────────────│
```

**Backend:** Lambda + API Gateway + DynamoDB + Cognito + Secrets Manager
**Region:** us-east-1
**Billing:** Pay-per-request (effectively $0 at dev scale)

---

## 1. Setup (One-Time Infrastructure)

### 1.1 Generate a Registration API Key

```bash
# Generate a secure random key
openssl rand -base64 32
# Example output: a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6
```

Save this key securely. All app agents will use it to register.

### 1.2 Set Environment Variables for CDK Deploy

```bash
export REGISTRATION_API_KEY="your-generated-key-here"
export API_BASE_URL="https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1"
```

### 1.3 (Optional) Create OAuth Credentials Secret

Only needed if you want GitHub/Atlassian OAuth. Google/LinkedIn work via existing env vars.

```bash
aws secretsmanager create-secret \
  --name futurator-core/oauth-credentials \
  --region us-east-1 \
  --secret-string '{
    "github": {
      "clientId": "your-github-oauth-app-client-id",
      "clientSecret": "your-github-oauth-app-client-secret"
    },
    "atlassian": {
      "clientId": "your-atlassian-oauth-app-client-id",
      "clientSecret": "your-atlassian-oauth-app-client-secret"
    }
  }'
```

### 1.4 Deploy

```bash
cd futurator-core-infra

# If Docker is NOT running, install esbuild for local Lambda bundling:
npm install --save-dev esbuild

# Deploy all stacks
REGISTRATION_API_KEY="your-key" API_BASE_URL="https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1" \
  npx cdk deploy --all --require-approval never
```

**Note:** CDK bundles Lambda code using Docker by default. If Docker isn't available, it falls back to local `esbuild` -- which must be installed as a dev dependency.

---

## 2. Register a New App (For App Agents)

**This is the primary improvement.** A single API call returns everything your app needs.

### Request

```bash
BROKER="https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1"
REG_KEY="your-registration-api-key"

curl -s -X POST "$BROKER/apps/register" \
  -H "Content-Type: application/json" \
  -H "X-Registration-Key: $REG_KEY" \
  -d '{
    "appId": "my-app",
    "name": "My Application",
    "type": "web",
    "baseUrl": "http://localhost:3000"
  }' | jq '.'
```

### What `baseUrl` does (smart defaults)

If you provide `baseUrl` instead of explicit URIs, the broker auto-generates:

| Input                              | Generated                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `baseUrl: "http://localhost:3000"` | `redirectUris: ["http://localhost:3000/auth/callback", "http://localhost:3000/admin/callback"]` |
|                                    | `allowedOrigins: ["http://localhost:3000"]`                                                     |

You can override with explicit `redirectUris` and `allowedOrigins` arrays if needed.

### Response (complete integration info)

```json
{
  "alreadyExisted": false,
  "appId": "my-app",
  "clientId": "app_abc123def456...",
  "clientSecret": "Rk9vQmFyQmF6...",
  "createdAt": "2026-04-03T...",
  "config": {
    "name": "My Application",
    "type": "web",
    "redirectUris": ["http://localhost:3000/auth/callback", "http://localhost:3000/admin/callback"],
    "allowedOrigins": ["http://localhost:3000"]
  },
  "broker": {
    "baseUrl": "https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1",
    "jwksEndpoint": "https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1/.well-known/jwks.json",
    "endpoints": {
      "register": ".../auth/register",
      "verifyEmail": ".../auth/verify-email",
      "login": ".../auth/login",
      "refresh": ".../auth/refresh",
      "logout": ".../auth/logout",
      "profile": ".../auth/profile",
      "sessions": ".../auth/sessions",
      "oauthExchange": ".../auth/oauth/exchange",
      "oauthProviders": ".../auth/oauth/providers"
    },
    "oauthProviders": {
      "google": { "initiateUrl": ".../auth/oauth/google?appId=my-app" },
      "linkedin": { "initiateUrl": ".../auth/oauth/linkedin?appId=my-app" },
      "github": { "initiateUrl": ".../auth/oauth/github?appId=my-app" },
      "atlassian": { "initiateUrl": ".../auth/oauth/atlassian?appId=my-app" }
    }
  },
  "quickstart": {
    "envVars": {
      "IDENTITY_BROKER_URL": "https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1",
      "IDENTITY_BROKER_APP_ID": "my-app",
      "IDENTITY_BROKER_CLIENT_ID": "app_abc123def456...",
      "IDENTITY_BROKER_CLIENT_SECRET": "Rk9vQmFyQmF6...",
      "IDENTITY_BROKER_JWKS_URL": ".../well-known/jwks.json"
    },
    "envFile": "IDENTITY_BROKER_URL=...\nIDENTITY_BROKER_APP_ID=my-app\n..."
  }
}
```

**Save `clientSecret` immediately -- it is only shown once.**

### Idempotent

Calling register again with the same `appId` returns 200 with the existing config and all integration URLs, but `clientSecret: null`. Safe to call repeatedly.

### No admin JWT needed

The old `POST /admin/apps/register` (requiring Cognito admin login) still works for backward compatibility, but the new `POST /apps/register` only needs the `X-Registration-Key` header.

### Update App Config (Self-Service)

After registration, you can update redirectUris, allowedOrigins, or name using the same API key:

```bash
curl -s -X PUT "$BROKER/apps/futurator-admin" \
  -H "Content-Type: application/json" \
  -H "X-Registration-Key: $REG_KEY" \
  -d '{
    "redirectUris": [
      "https://myapp.futurator.ai/auth/callback",
      "https://myapp.futurator.ai/admin/callback",
      "http://localhost:3000/auth/callback",
      "http://localhost:3000/admin/callback"
    ],
    "allowedOrigins": [
      "https://myapp.futurator.ai",
      "http://localhost:3000"
    ]
  }' | jq '.'
```

**Important: Put your production URL first.** The broker uses the first `redirectUri` as the default when the OAuth initiate call doesn't specify a `redirect_uri` parameter. If localhost is first, Google OAuth will redirect to localhost even when the user is on your production site.

You can also pass `baseUrl` to regenerate defaults:

```bash
curl -s -X PUT "$BROKER/apps/my-app" \
  -H "Content-Type: application/json" \
  -H "X-Registration-Key: $REG_KEY" \
  -d '{"baseUrl": "https://myapp.futurator.ai"}'
```

---

## 3. Authentication Methods

### 3.1 Email/Password (No app registration needed for basic usage)

```bash
# Register a user
curl -X POST "$BROKER/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"MyPass123!","name":"Jane Doe"}'

# Verify email (user receives code via email)
curl -X POST "$BROKER/auth/verify-email" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","code":"123456"}'

# Login
curl -X POST "$BROKER/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"MyPass123!"}'
# Returns: { accessToken, idToken, refreshToken, expiresIn, familyId, tokenId, user }

# Refresh tokens (always use the NEW refreshToken returned)
curl -X POST "$BROKER/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJ...","familyId":"fam_...","tokenId":"tok_..."}'

# Get profile (protected)
curl "$BROKER/auth/profile" \
  -H "Authorization: Bearer ACCESS_TOKEN"

# Logout
curl -X POST "$BROKER/auth/logout" \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

### 3.2 Google OAuth (Requires app registration)

**Flow:**

1. Frontend redirects to: `GET {broker}/auth/oauth/google?appId={appId}`
2. User completes Google consent
3. Broker redirects to your `redirectUri` with `?code=otp_abc123...`
4. Your backend exchanges the OTP code for JWT tokens

**Exchange (backend-to-backend):**

```bash
curl -X POST "$BROKER/auth/oauth/exchange" \
  -H "Content-Type: application/json" \
  -H "X-App-Id: my-app" \
  -d '{
    "code": "otp_abc123...",
    "clientId": "app_abc123def456...",
    "clientSecret": "Rk9vQmFyQmF6..."
  }'
# Returns: { accessToken, idToken, refreshToken, user: { userId, email, name, ... } }
```

### 3.3 LinkedIn OAuth

Same flow as Google, replace `google` with `linkedin` in the initiate URL.

### 3.4 GitHub OAuth (NEW)

Same flow as Google, replace `google` with `github`:

```
GET {broker}/auth/oauth/github?appId={appId}
```

**Requires:** GitHub OAuth App credentials in Secrets Manager (`futurator-core/oauth-credentials`).

GitHub-specific: handles users with private emails by calling GitHub's `/user/emails` API.

### 3.5 Atlassian OAuth (NEW)

Same flow, replace with `atlassian`:

```
GET {broker}/auth/oauth/atlassian?appId={appId}
```

**Requires:** Atlassian OAuth App credentials in Secrets Manager.

Atlassian-specific: uses JSON body for token exchange (not form-urlencoded), requires `audience=api.atlassian.com`.

---

## 4. Discover Available Providers

```bash
curl "$BROKER/auth/oauth/providers?appId=my-app" | jq '.'
```

Returns:

```json
{
  "providers": [
    {
      "name": "google",
      "displayName": "Google",
      "initiateUrl": ".../auth/oauth/google?appId=my-app",
      "configured": true,
      "scopes": ["openid", "profile", "email"]
    },
    {
      "name": "linkedin",
      "displayName": "LinkedIn",
      "initiateUrl": ".../auth/oauth/linkedin?appId=my-app",
      "configured": true,
      "scopes": ["openid", "profile", "email"]
    },
    {
      "name": "github",
      "displayName": "GitHub",
      "initiateUrl": ".../auth/oauth/github?appId=my-app",
      "configured": true,
      "scopes": ["user:email", "read:user"]
    },
    {
      "name": "atlassian",
      "displayName": "Atlassian",
      "initiateUrl": ".../auth/oauth/atlassian?appId=my-app",
      "configured": true,
      "scopes": ["read:me", "read:account"]
    }
  ]
}
```

`configured: false` means the provider's credentials aren't in Secrets Manager yet.

---

## 5. Health Check

```bash
curl "$BROKER/health" | jq '.'
```

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "region": "us-east-1",
  "environment": "dev",
  "timestamp": "2026-04-03T...",
  "services": { "dynamodb": "connected" }
}
```

---

## 6. Admin Endpoints

These require a Cognito admin JWT (role: `admin`).

```bash
# Get app config (secret redacted)
curl "$BROKER/admin/apps/my-app" \
  -H "Authorization: Bearer ADMIN_TOKEN"

# Update app config
curl -X PUT "$BROKER/admin/apps/my-app" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"redirectUris": ["http://localhost:3000/auth/callback", "https://myapp.futurator.ai/auth/callback"]}'

# Rotate client secret (returns new secret, invalidates old one)
curl -X POST "$BROKER/admin/apps/my-app/rotate-secret" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

---

## 7. Frontend Integration (TypeScript)

```typescript
const BROKER_URL = process.env.IDENTITY_BROKER_URL!;
const APP_ID = process.env.IDENTITY_BROKER_APP_ID!;
const CLIENT_SECRET = process.env.IDENTITY_BROKER_CLIENT_SECRET!;

// Initiate Google OAuth (redirect user)
function loginWithGoogle() {
  window.location.href = `${BROKER_URL}/auth/oauth/google?appId=${APP_ID}`;
}

// Handle callback (on your /auth/callback page)
async function handleOAuthCallback(code: string) {
  const res = await fetch(`${BROKER_URL}/auth/oauth/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Id': APP_ID,
    },
    body: JSON.stringify({ code, clientId: APP_ID, clientSecret: CLIENT_SECRET }),
  });
  const data = await res.json();
  // data.accessToken, data.idToken, data.refreshToken, data.user
  sessionStorage.setItem('accessToken', data.accessToken);
  return data;
}

// Make authenticated requests
async function fetchProfile() {
  const token = sessionStorage.getItem('accessToken');
  const res = await fetch(`${BROKER_URL}/auth/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}
```

---

## 8. Token Refresh and Staying Logged In

### Token Lifetimes

| Token         | Lifetime    | Storage                                            |
| ------------- | ----------- | -------------------------------------------------- |
| Access Token  | **1 hour**  | Memory or `sessionStorage`                         |
| ID Token      | **1 hour**  | Memory or `sessionStorage`                         |
| Refresh Token | **30 days** | `httpOnly` cookie (prod) or `sessionStorage` (dev) |

### How Refresh Token Rotation Works (OAuth 2.1)

The broker implements **refresh token rotation** for security. Every time you refresh, the old refresh token is invalidated and a new one is issued.

```
Login → accessToken (1h) + refreshToken + familyId + tokenId
         │
         │  ... 55 minutes later (token about to expire) ...
         │
         ▼
POST /auth/refresh { refreshToken, familyId, tokenId }
         │
         ▼
New accessToken (1h) + new refreshToken + same familyId + NEW tokenId
         │
         │  ... always use the LATEST refreshToken and tokenId ...
         │
         ▼
POST /auth/refresh { refreshToken, familyId, newTokenId }
         │
         ▼
New accessToken + new refreshToken + NEW tokenId
```

**Critical rules:**

- Always store and use the **latest** `refreshToken` and `tokenId` returned
- If you send an old/reused token outside the 30-second grace period, the **entire family is revoked** (all devices logged out) as a security measure
- The `familyId` stays the same for the entire session; only `tokenId` changes

### Auto-Refresh Implementation (TypeScript)

```typescript
const BROKER_URL = process.env.IDENTITY_BROKER_URL!;

// Token state -- keep in memory, not localStorage
let accessToken: string | null = null;
let refreshToken: string | null = null;
let familyId: string | null = null;
let tokenId: string | null = null;
let expiresAt: number = 0;

function storeTokens(data: {
  accessToken: string;
  refreshToken?: string;
  familyId?: string;
  tokenId?: string;
  expiresIn: number;
}) {
  accessToken = data.accessToken;
  if (data.refreshToken) refreshToken = data.refreshToken;
  if (data.familyId) familyId = data.familyId;
  if (data.tokenId) tokenId = data.tokenId;
  expiresAt = Date.now() + data.expiresIn * 1000;
}

function isTokenExpiringSoon(): boolean {
  // Refresh 5 minutes before expiry
  return Date.now() > expiresAt - 5 * 60 * 1000;
}

async function refreshTokens(): Promise<boolean> {
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${BROKER_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, familyId, tokenId }),
    });

    if (!res.ok) {
      // Refresh failed -- user must log in again
      clearTokens();
      return false;
    }

    const data = await res.json();
    storeTokens(data);
    return true;
  } catch {
    return false;
  }
}

function clearTokens() {
  accessToken = null;
  refreshToken = null;
  familyId = null;
  tokenId = null;
  expiresAt = 0;
}

// Fetch wrapper that auto-refreshes
async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (isTokenExpiringSoon()) {
    const refreshed = await refreshTokens();
    if (!refreshed) {
      throw new Error('Session expired. Please log in again.');
    }
  }

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });
}
```

### Multi-Tab / Concurrent Requests

The broker has a **30-second grace period** for concurrent refresh requests. If two tabs refresh at the same time:

- The first request rotates the token normally
- The second request (within 30 seconds) gets the same tokens from the already-completed rotation
- After 30 seconds, reusing the old token revokes the entire family

**Best practice:** Use a mutex/lock or `BroadcastChannel` to coordinate token refresh across tabs.

---

## 9. Error Handling

### Error Response Format (RFC 7807)

All errors from the broker follow the Problem Details standard:

```json
{
  "type": "https://api.futurator.com/errors/unauthorized",
  "title": "UnauthorizedError",
  "status": 401,
  "detail": "Invalid refresh token",
  "instance": "/auth/refresh",
  "correlationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-04-03T12:00:00.000Z"
}
```

**Content-Type:** `application/problem+json`

### Error Types and How to Handle Them

| Status | Error Type            | Meaning                     | Action                |
| ------ | --------------------- | --------------------------- | --------------------- |
| 400    | `validation-error`    | Invalid request body/params | Fix the request       |
| 400    | `bad-request`         | Missing required field      | Check required fields |
| 401    | `unauthorized`        | Invalid/expired token       | Re-authenticate       |
| 403    | `forbidden`           | Insufficient permissions    | Check user role       |
| 404    | `not-found`           | Resource doesn't exist      | Check the ID/path     |
| 409    | `conflict`            | Resource already exists     | Use existing resource |
| 429    | `rate-limit-exceeded` | Too many requests           | Wait and retry        |
| 500    | `internal-error`      | Server-side failure         | Retry or report       |

### Rate Limit Headers

Every response includes rate limit info when rate limiting is active:

```
X-RateLimit-Limit: 5          # Max requests per window
X-RateLimit-Remaining: 3      # Requests remaining
X-RateLimit-Reset: 1712150400 # Unix timestamp when window resets
Retry-After: 45               # Seconds to wait (only on 429)
```

### Rate Limits by Endpoint

| Endpoint                            | Limit | Window | Key    |
| ----------------------------------- | ----- | ------ | ------ |
| `/auth/login`                       | 5     | 60s    | IP     |
| `/auth/register`                    | 3     | 60s    | IP     |
| `/auth/refresh`                     | 20    | 60s    | userId |
| `/auth/profile`                     | 100   | 60s    | userId |
| `/auth/verify-email`                | 10    | 60s    | IP     |
| `/auth/forgot-password`             | 3     | 60s    | IP     |
| `/admin/apps/register`              | 10    | 60s    | userId |
| `/admin/apps/{appId}/rotate-secret` | 5     | 60s    | userId |
| OAuth endpoints                     | 10    | 60s    | IP     |

### Correlation ID for Debugging

Every request generates a `X-Correlation-Id` header. Send it when reporting issues:

```typescript
const res = await fetch(`${BROKER_URL}/auth/login`, { ... })
if (!res.ok) {
  const correlationId = res.headers.get('X-Correlation-Id')
  console.error(`Auth failed. Correlation ID: ${correlationId}`)
  // Include this ID when reporting to the platform team
}
```

You can also send your own correlation ID to trace across services:

```typescript
fetch(`${BROKER_URL}/auth/profile`, {
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Correlation-Id': 'my-trace-id-12345',
  },
});
```

### Error Handling Template (TypeScript)

```typescript
async function callBroker(url: string, options: RequestInit) {
  const res = await fetch(url, options);

  if (res.ok) return res.json();

  const error = await res.json().catch(() => ({}));
  const correlationId = res.headers.get('X-Correlation-Id');

  switch (res.status) {
    case 401:
      // Token expired or invalid -- refresh or redirect to login
      const refreshed = await refreshTokens();
      if (refreshed) return callBroker(url, options); // Retry once
      throw new Error('Session expired');

    case 429:
      // Rate limited -- wait and retry
      const retryAfter = parseInt(res.headers.get('Retry-After') || '60');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return callBroker(url, options); // Retry after wait

    default:
      throw new Error(`${error.title}: ${error.detail} [${correlationId}]`);
  }
}
```

---

## 10. Best Practices

### Token Storage

| Environment     | Access Token       | Refresh Token            | Client Secret                     |
| --------------- | ------------------ | ------------------------ | --------------------------------- |
| **Development** | `sessionStorage`   | `sessionStorage`         | `.env.local` (never commit)       |
| **Production**  | In-memory variable | `httpOnly` secure cookie | Lambda env var (server-side only) |

**Never use `localStorage`** for tokens -- it's accessible to XSS attacks. `sessionStorage` clears when the tab closes, which is acceptable for dev. In production, keep the access token in a JavaScript variable and the refresh token in an `httpOnly` cookie that only your backend can read.

### Client Secret Handling

```
WRONG (production):
  Frontend JS has the clientSecret → anyone can extract it from the bundle

RIGHT (production):
  Frontend → your backend Lambda → Identity Broker
  Only your Lambda knows the clientSecret
  Frontend never sees it

OK (development only):
  Frontend calls broker directly with clientSecret from .env.local
  Acceptable because localhost isn't publicly accessible
```

### OAuth Flow Security

- **Always use the server-side exchange pattern** in production: your backend holds the `clientSecret` and exchanges the OTP code with the broker
- **OTP codes expire in 60 seconds** and are single-use -- exchange immediately upon receiving them
- **State tokens expire in 10 minutes** -- don't let users linger on the consent screen
- **Never put user data in URLs** -- the broker uses OTP codes, not email/name in redirect params

### Redirect URI Configuration

- Register your exact redirect URIs (no wildcards)
- **First URI is the default redirect target** -- always put your **production URL first**
- In production, use `https://` only
- When your app runs on both localhost and production, order them: production first, localhost second
- **Pass `redirect_uri` explicitly** in the OAuth initiate URL to override the default:
  ```
  GET /auth/oauth/google?appId=my-app&redirect_uri=https://myapp.futurator.ai/auth/callback
  ```
  The `redirect_uri` must be in the app's registered list or the broker will reject it.
- Update URIs when you get a production domain:

```bash
curl -X PUT "$BROKER/admin/apps/my-app" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "redirectUris": [
      "http://localhost:3000/auth/callback",
      "https://myapp.futurator.ai/auth/callback"
    ],
    "allowedOrigins": [
      "http://localhost:3000",
      "https://myapp.futurator.ai"
    ]
  }'
```

### CORS

The broker dynamically sets `Access-Control-Allow-Origin` based on your registered `allowedOrigins`. If you get CORS errors:

1. Check that your origin is in the app's `allowedOrigins` array
2. Include the protocol and port: `http://localhost:3000` not `localhost:3000`
3. No trailing slashes

### When to Use Which Auth Method

| Scenario                             | Recommended Method                                  |
| ------------------------------------ | --------------------------------------------------- |
| Internal admin panel                 | Google OAuth (whitelist admin emails in your app)   |
| Public app with registration         | Email/password (with optional social login buttons) |
| Developer tool / CLI                 | Email/password (no browser needed)                  |
| App where users have GitHub accounts | GitHub OAuth                                        |
| Jira/Confluence integration          | Atlassian OAuth                                     |

### Refresh Token Best Practices

1. **Refresh proactively** -- refresh 5 minutes before expiry, not after failure
2. **Never store both tokens in the same place** -- if one leaks, the other is still safe
3. **Handle revocation gracefully** -- if refresh fails with 401, redirect to login without a flash of error
4. **Coordinate across tabs** -- use `BroadcastChannel` or a shared lock to prevent simultaneous refreshes

### Password Requirements

When using email/password auth, passwords must have:

- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 number
- At least 1 special character

### Common Pitfalls — Do NOT

These are real issues encountered during the Futurator Admin Hub integration. Every item here caused a production bug.

#### Do NOT use httpOnly cookies when frontend and API are on different domains

If your app is a static export (S3/CloudFront) calling a Lambda Function URL, they are on different domains. Cookies set by the Lambda are scoped to the Lambda's domain (`xxx.lambda-url.us-east-1.on.aws`) and are **invisible** to the static site (`yourapp.futurator.ai`). Modern browsers also block third-party cookies by default.

**Instead:** Use Bearer tokens. Have the static callback page call your API Lambda's exchange endpoint via `fetch`, receive tokens as JSON, store in `sessionStorage`, and send as `Authorization: Bearer` header on every request.

This only applies to serverless (static + Lambda URL) apps. Fargate apps where the frontend and API share the same origin can use cookies safely.

#### Do NOT set CORS headers at both the framework level AND the Lambda Function URL level

Lambda Function URLs have built-in CORS configuration. If your code (Hono, Express, Fastify) also adds CORS middleware, responses will contain **duplicate** `Access-Control-Allow-Origin` headers. Browsers reject this — even when both values are identical.

**Instead:** Choose one:

- **Lambda Function URL CORS** (recommended for serverless): configure in SST/CDK, remove framework CORS middleware entirely
- **Framework CORS middleware** (recommended for Fargate): configure in code, don't set CORS on the function URL

#### Do NOT put localhost first in your redirect URIs

The broker uses the **first URI** in `redirectUris` as the default redirect target. If localhost is first, production OAuth will redirect users to `localhost:3000` — which doesn't exist on their machine.

**Instead:** Always order production-first, localhost-second:

```json
{
  "redirectUris": [
    "https://yourapp.futurator.ai/auth/callback",
    "http://localhost:3000/auth/callback"
  ]
}
```

#### Do NOT exchange OTP codes via redirect chains

OTP codes expire in **60 seconds** and are single-use. If your callback page redirects to another URL which then redirects again before exchanging, you risk expiring the OTP or using it in a context where CORS blocks the exchange.

**Instead:** Exchange the OTP immediately on the callback page itself using `fetch`. The callback page should:

1. Read `?code=otp_xxx` from the URL
2. POST it to your backend's exchange endpoint
3. Receive tokens as JSON
4. Store tokens and redirect to the app

#### Do NOT forget `trailingSlash: true` for static exports on CloudFront

Next.js static export generates files like `/auth/callback.html`. CloudFront/S3 cannot resolve `/auth/callback` (without `.html`) for nested paths. Top-level paths (`/login`) work, but nested paths (`/auth/callback`, `/projects/contento`) return 403 Access Denied.

**Instead:** Set `trailingSlash: true` in `next.config.ts`. This generates `/auth/callback/index.html` which CloudFront resolves natively.

### Recommended Auth Pattern by App Type

| App Type                         | Token Storage                  | Token Delivery                        | Secret Location              |
| -------------------------------- | ------------------------------ | ------------------------------------- | ---------------------------- |
| **Fargate (SSR)**                | httpOnly cookies               | Set-Cookie from same-origin API route | Container env var (from SSM) |
| **Serverless (static + Lambda)** | sessionStorage + Bearer header | JSON response from API Lambda         | Lambda env var (from SSM)    |
| **Development (any)**            | sessionStorage                 | JSON response                         | `.env.local` (never commit)  |

### Production Deployment Checklist

- [ ] `REGISTRATION_API_KEY` is set and distributed securely to app teams
- [ ] `API_BASE_URL` points to the correct broker deployment
- [ ] OAuth credentials are in Secrets Manager (not env vars with placeholders)
- [ ] App's `redirectUris` have **production domain FIRST** (HTTPS)
- [ ] App's `allowedOrigins` include production domain
- [ ] Client secret is stored in backend env vars, not frontend code
- [ ] CORS is configured in **one place only** (framework OR function URL, not both)
- [ ] Token refresh logic is implemented with auto-retry
- [ ] Error handling follows the RFC 7807 format
- [ ] `X-Correlation-Id` is logged for debugging
- [ ] Static export uses `trailingSlash: true` if deploying to S3/CloudFront

---

## 11. JWT Token Validation (Local)

Validate tokens locally using the JWKS endpoint -- no need to call the broker on every request.

```typescript
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: `${BROKER_URL}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 3600000, // 1 hour
});

async function validateToken(token: string) {
  const decoded = jwt.decode(token, { complete: true });
  const key = await client.getSigningKey(decoded!.header.kid);
  return jwt.verify(token, key.getPublicKey(), {
    issuer: 'https://api.futurator.com/v1',
    algorithms: ['RS256'],
  });
}
```

**Access token claims include:** `userId`, `email`, `tenantId`, `role`, `activeApps`, `familyId`

---

## 12. Complete API Reference

### Public Endpoints (no auth)

| Method | Path                             | Purpose                                  |
| ------ | -------------------------------- | ---------------------------------------- |
| `POST` | `/apps/register`                 | Self-service app registration (API key)  |
| `PUT`  | `/apps/{appId}`                  | Self-service app config update (API key) |
| `GET`  | `/health`                        | Service health check                     |
| `POST` | `/auth/register`                 | User registration                        |
| `POST` | `/auth/verify-email`             | Email verification                       |
| `POST` | `/auth/resend-verification`      | Resend verification code                 |
| `POST` | `/auth/login`                    | Password login                           |
| `POST` | `/auth/refresh`                  | Token refresh (with rotation)            |
| `POST` | `/auth/forgot-password`          | Initiate password reset                  |
| `POST` | `/auth/reset-password`           | Complete password reset                  |
| `GET`  | `/.well-known/jwks.json`         | JWT public keys                          |
| `GET`  | `/auth/oauth/google`             | Google OAuth initiate                    |
| `GET`  | `/auth/oauth/google/callback`    | Google OAuth callback                    |
| `GET`  | `/auth/oauth/linkedin`           | LinkedIn OAuth initiate                  |
| `GET`  | `/auth/oauth/linkedin/callback`  | LinkedIn OAuth callback                  |
| `GET`  | `/auth/oauth/github`             | GitHub OAuth initiate                    |
| `GET`  | `/auth/oauth/github/callback`    | GitHub OAuth callback                    |
| `GET`  | `/auth/oauth/atlassian`          | Atlassian OAuth initiate                 |
| `GET`  | `/auth/oauth/atlassian/callback` | Atlassian OAuth callback                 |
| `GET`  | `/auth/oauth/providers`          | Discover available providers             |
| `POST` | `/auth/oauth/exchange`           | Exchange OTP for JWT tokens              |

### Protected Endpoints (JWT required)

| Method   | Path                         | Purpose            |
| -------- | ---------------------------- | ------------------ |
| `GET`    | `/auth/profile`              | Get user profile   |
| `GET`    | `/auth/sessions`             | List user sessions |
| `DELETE` | `/auth/sessions/{sessionId}` | Revoke a session   |
| `POST`   | `/auth/logout`               | Logout             |

### Admin Endpoints (admin JWT required)

| Method | Path                                | Purpose                          |
| ------ | ----------------------------------- | -------------------------------- |
| `POST` | `/admin/apps/register`              | Register app (legacy, admin JWT) |
| `GET`  | `/admin/apps/{appId}`               | Get app config (secret redacted) |
| `PUT`  | `/admin/apps/{appId}`               | Update app config                |
| `POST` | `/admin/apps/{appId}/rotate-secret` | Rotate client secret             |

---

## 13. Troubleshooting

| Symptom                                    | Cause                                         | Fix                                                                                                 |
| ------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `500 "Registration key not configured"`    | `REGISTRATION_API_KEY` env var not set        | Set it during CDK deploy                                                                            |
| `401 "Invalid registration key"`           | Wrong key in `X-Registration-Key` header      | Use the correct key                                                                                 |
| `500 "OAuth provider X is not configured"` | Missing credentials in Secrets Manager        | Create `futurator-core/oauth-credentials` secret                                                    |
| `403 Missing Authentication Token`         | Hitting wrong broker URL (prod vs dev)        | Use dev: `vnfmz85xj1`                                                                               |
| `"State token already used"`               | Browser prefetched callback or page refreshed | Retry from login page                                                                               |
| OAuth redirects to localhost in production | First `redirectUri` is localhost              | `PUT /apps/{appId}` with production URL first, or pass `redirect_uri` query param in OAuth initiate |
| `"clientSecret is required"`               | Secret mismatch between env and DynamoDB      | Re-register or rotate secret                                                                        |

---

## 14. Infrastructure References

| Resource          | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| Dev Broker URL    | `https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1` |
| Prod Broker URL   | `https://uyocidd3ll.execute-api.us-east-1.amazonaws.com/v1` |
| DynamoDB Table    | `dev-Futurator_Core_Data`                                   |
| Cognito User Pool | `us-east-1_djPwzFjUe`                                       |
| AWS Region        | `us-east-1`                                                 |
| AWS Account       | `835745294770`                                              |
