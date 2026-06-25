// privacy-detectors.mjs — shared detection tables for the INTERNAL data-privacy
// scanner AND graph role-tagging. One source of truth so "the graph distinguishes
// infra / 3rd-party / AI / db" and "the scanner detects providers" use the SAME
// rules. Deterministic, ~0 LLM, no network.
//
// Two detection surfaces:
//   classifyImport(specifier) — a package import → { kind, provider, residency }
//   classifyPath(file)        — a file PATH/name → { kind, provider } (IaC files,
//                               db tables, prisma schema, etc.)
// `kind` is the coarse role used by the graph: 'ai' | 'db' | 'infra' | 'thirdParty'.

// ── import-based detectors (npm package specifiers) ──
// residency: 'external' = personal data may leave to a 3rd party · 'in-account'
// = stays in the operator's own cloud account · 'varies' = depends on config.
export const IMPORT_DETECTORS = [
  // AI providers — the "which AI and how" signal
  { kind: 'ai', provider: 'Anthropic (Claude API)', residency: 'external', test: (s) => s === 'anthropic' || /^@anthropic-ai\//.test(s) },
  { kind: 'ai', provider: 'AWS Bedrock', residency: 'in-account', test: (s) => /^@aws-sdk\/client-bedrock/.test(s) },
  { kind: 'ai', provider: 'OpenAI', residency: 'external', test: (s) => s === 'openai' || /^@openai\//.test(s) },
  { kind: 'ai', provider: 'Google Gemini', residency: 'external', test: (s) => s === '@google/generative-ai' || /^@google-cloud\/aiplatform/.test(s) },
  { kind: 'ai', provider: 'Cohere', residency: 'external', test: (s) => /^cohere(-ai)?$/.test(s) },
  { kind: 'ai', provider: 'Vercel AI SDK', residency: 'varies', test: (s) => s === 'ai' || /^@ai-sdk\//.test(s) },
  { kind: 'ai', provider: 'Replicate', residency: 'external', test: (s) => s === 'replicate' },
  { kind: 'ai', provider: 'Ollama (local)', residency: 'in-account', test: (s) => /^ollama/.test(s) },

  // databases — "where is user information stored"
  { kind: 'db', provider: 'DynamoDB', residency: 'in-account', test: (s) => /^@aws-sdk\/(client|lib)-dynamodb/.test(s) },
  { kind: 'db', provider: 'Postgres', residency: 'varies', test: (s) => s === 'pg' || s === 'postgres' || /^postgres(\.js)?$/.test(s) },
  { kind: 'db', provider: 'Prisma', residency: 'varies', test: (s) => s === '@prisma/client' || s === 'prisma' },
  { kind: 'db', provider: 'Drizzle', residency: 'varies', test: (s) => /^drizzle-orm/.test(s) },
  { kind: 'db', provider: 'MongoDB', residency: 'varies', test: (s) => s === 'mongodb' || s === 'mongoose' },
  { kind: 'db', provider: 'Redis', residency: 'varies', test: (s) => s === 'redis' || s === 'ioredis' },
  { kind: 'db', provider: 'Supabase', residency: 'external', test: (s) => /^@supabase\//.test(s) },

  // IaC / infrastructure-as-code (package form; path form in PATH_DETECTORS)
  { kind: 'infra', provider: 'Pulumi', residency: 'in-account', test: (s) => /^@pulumi\//.test(s) },
  { kind: 'infra', provider: 'AWS CDK', residency: 'in-account', test: (s) => s === 'aws-cdk-lib' || /^@aws-cdk\//.test(s) },
  { kind: 'infra', provider: 'SST', residency: 'in-account', test: (s) => s === 'sst' || /^@serverless-stack\//.test(s) },
  { kind: 'infra', provider: 'Serverless Framework', residency: 'in-account', test: (s) => s === 'serverless' },

  // 3rd-party services that touch / receive personal data
  { kind: 'thirdParty', provider: 'Stripe', residency: 'external', test: (s) => s === 'stripe' || /^@stripe\//.test(s) },
  { kind: 'thirdParty', provider: 'SendGrid', residency: 'external', test: (s) => /^@sendgrid\//.test(s) },
  { kind: 'thirdParty', provider: 'Twilio', residency: 'external', test: (s) => s === 'twilio' },
  { kind: 'thirdParty', provider: 'Clerk (auth)', residency: 'external', test: (s) => /^@clerk\//.test(s) },
  { kind: 'thirdParty', provider: 'Auth0 / NextAuth', residency: 'external', test: (s) => /^@auth0\//.test(s) || s === 'next-auth' || /^next-auth\//.test(s) },
  { kind: 'thirdParty', provider: 'AWS S3', residency: 'in-account', test: (s) => /^@aws-sdk\/client-s3/.test(s) },
  { kind: 'thirdParty', provider: 'AWS SES (email)', residency: 'in-account', test: (s) => /^@aws-sdk\/client-ses/.test(s) },
  { kind: 'thirdParty', provider: 'Sentry (telemetry)', residency: 'external', test: (s) => /^@sentry\//.test(s) },
  { kind: 'thirdParty', provider: 'PostHog (analytics)', residency: 'external', test: (s) => /posthog/.test(s) },
  { kind: 'thirdParty', provider: 'Mixpanel (analytics)', residency: 'external', test: (s) => /^mixpanel/.test(s) },
  { kind: 'thirdParty', provider: 'Segment (analytics)', residency: 'external', test: (s) => /^@segment\//.test(s) || s === 'analytics-node' },
]

// ── path-based detectors (IaC files, schemas, table modules) ──
export const PATH_DETECTORS = [
  { kind: 'infra', provider: 'Terraform', residency: 'in-account', test: (f) => /\.tf$/.test(f) || /\.tf\.json$/.test(f) },
  { kind: 'infra', provider: 'Pulumi', residency: 'in-account', test: (f) => /(^|\/)Pulumi\.[^/]*\.?ya?ml$/.test(f) },
  { kind: 'infra', provider: 'SST config', residency: 'in-account', test: (f) => /(^|\/)sst\.config\.[tj]s$/.test(f) },
  { kind: 'infra', provider: 'Serverless config', residency: 'in-account', test: (f) => /(^|\/)serverless\.ya?ml$/.test(f) },
  { kind: 'infra', provider: 'CloudFormation', residency: 'in-account', test: (f) => /(^|\/)(template|cloudformation)\.ya?ml$/.test(f) },
  { kind: 'db', provider: 'Prisma schema', residency: 'varies', test: (f) => /(^|\/)schema\.prisma$/.test(f) },
]

/** First import detector that matches the specifier, or null. */
export function classifyImport(spec) {
  for (const d of IMPORT_DETECTORS) if (d.test(spec)) return { kind: d.kind, provider: d.provider, residency: d.residency }
  return null
}

/** First path detector that matches the file, or null. */
export function classifyPath(file) {
  for (const d of PATH_DETECTORS) if (d.test(file)) return { kind: d.kind, provider: d.provider, residency: d.residency }
  return null
}

/**
 * Classify a file from its specifiers + path → the set of role kinds it carries
 * + the concrete detections. Used by alias-resolve (graph roles) and the scanner.
 * @returns {{ kinds: string[], detections: Array<{kind,provider,residency}> }}
 */
export function classifyFile(file, specifiers = []) {
  const detections = []
  const seen = new Set()
  const add = (d) => { if (!d) return; const k = `${d.kind}:${d.provider}`; if (!seen.has(k)) { seen.add(k); detections.push(d) } }
  add(classifyPath(file))
  for (const s of specifiers) add(classifyImport(s))
  return { kinds: [...new Set(detections.map((d) => d.kind))], detections }
}

/** Coarse single role for graph coloring (one node, one role): infra > db > ai > thirdParty > null. */
export function primaryRole(kinds = []) {
  for (const r of ['infra', 'db', 'ai', 'thirdParty']) if (kinds.includes(r)) return r
  return null
}
