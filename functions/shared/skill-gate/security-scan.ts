/**
 * security-scan.ts — Skills Institution, Story 2.2 (2026-06-17). Gate-1.
 *
 * The ONE deterministic, blocking security gate every skill passes through
 * before it can be ratified or written into an app. A skill is plain text the
 * agent will *follow* (and whose bundled scripts an agent may *run*), so a
 * malicious skill is a prompt-injection / RCE vector. This scanner reads the
 * SKILL.md body + any bundled scripts and returns a verdict — it NEVER executes
 * the content.
 *
 * Determinism is the point: Gate-1 is mechanical pattern-matching (Phase-1 of
 * the Hermes governance line — automatable + principle-safe). The deeper,
 * fallible judgement (Gate-2 LLM review, Story 2.5) is on-demand + advisory and
 * lives elsewhere. Gate-1 is the only gate that can BLOCK.
 *
 * Verdict mapping:
 *   any `blocking` hit  → securityStatus: 'quarantined'  (not ratifiable w/o override)
 *   only `advisory` hits → securityStatus: 'flagged'      (surfaced, still ratifiable)
 *   no hits             → securityStatus: 'clean'
 *
 * Pure + dependency-free so it imports into the Lambda gate (Story 2.3), the
 * retro-scan script (Story 4.1), and — mirrored as `daemon/lib/security-scan.mjs`
 * with a parity test — the daemon apply path (Story 1.3).
 */

import type { SecurityStatus } from '../schemas/skill-index-entry-schema';

export type ScanSeverity = 'blocking' | 'advisory';

/** One pattern hit found in a skill's body or a bundled script. */
export interface PatternHit {
  /** Stable rule id (e.g. `destructive-shell`). */
  id: string;
  /** Human category for the inbox UI. */
  category: string;
  severity: ScanSeverity;
  /** What the rule looks for (shown to the curator). */
  description: string;
  /** The matched snippet, truncated — evidence for the curator. */
  evidence: string;
  /** Where it was found: `body` or the bundled script path. */
  location: string;
}

export interface ScanResult {
  securityStatus: Extract<SecurityStatus, 'clean' | 'flagged' | 'quarantined'>;
  patternsHit: PatternHit[];
}

export interface BundledScript {
  path: string;
  content: string;
}

export interface ScanInput {
  body: string;
  scripts?: BundledScript[];
}

export interface ScanOptions {
  /**
   * Hostnames (suffix-matched) treated as safe for command-context network
   * egress (`curl`, `wget`, `fetch`, package installs). A non-allowlisted host
   * in an egress context is a BLOCKING hit. Defaults to {@link DEFAULT_NETWORK_ALLOWLIST}.
   */
  networkAllowlist?: string[];
}

/**
 * Hosts the platform legitimately reaches: package registries, GitHub (the
 * federation lives there), Anthropic's API, and loopback. Anything else in an
 * egress context is treated as exfiltration until an operator says otherwise.
 */
export const DEFAULT_NETWORK_ALLOWLIST: readonly string[] = Object.freeze([
  'github.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'api.anthropic.com',
  'registry.npmjs.org',
  'npmjs.org',
  'npmjs.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'localhost',
  '127.0.0.1',
]);

const MAX_EVIDENCE = 160;
function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EVIDENCE ? `${flat.slice(0, MAX_EVIDENCE)}…` : flat;
}

/**
 * Static pattern rules. Each is a single regex (global, case-insensitive where
 * sensible) plus metadata. Network egress and base64 get bespoke handling
 * below because they need host/length logic a flat regex can't express.
 */
interface Rule {
  id: string;
  category: string;
  severity: ScanSeverity;
  description: string;
  regex: RegExp;
}

const RULES: Rule[] = [
  // --- secret / credential exfiltration ---
  {
    id: 'secret-file-read',
    category: 'exfiltration',
    severity: 'blocking',
    description: 'Reads a known secret/credential file',
    regex:
      /(~\/\.ssh\/id_[a-z0-9]+|~\/\.aws\/credentials|\.aws\/credentials|\.ssh\/id_rsa|\.npmrc|\.netrc|\/etc\/shadow|\.git-credentials)/gi,
  },
  {
    id: 'secret-env-name',
    category: 'exfiltration',
    severity: 'advisory',
    description: 'References a sensitive secret environment variable by name',
    regex:
      /\b(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|NPM_TOKEN|SLACK_TOKEN|STRIPE_SECRET_KEY|PRIVATE_KEY)\b/g,
  },
  {
    id: 'env-dump',
    category: 'exfiltration',
    severity: 'blocking',
    description: 'Dumps the whole environment and exfiltrates it',
    regex:
      /\b(printenv|env)\b\s*\|\s*(curl|wget|nc|netcat|bash|sh)\b|JSON\.stringify\s*\(\s*process\.env\s*\)/gi,
  },
  // --- destructive shell ---
  {
    id: 'destructive-rm',
    category: 'destructive',
    severity: 'blocking',
    description: 'Destructive recursive delete (rm -rf on root/home/cwd)',
    regex:
      /\brm\s+-(?:[a-z]*r[a-z]*f[a-z]*|[a-z]*f[a-z]*r[a-z]*)\s+(\/(?:\s|$|\*)|~|\$HOME|\.\s*$|\.\/|\*)/gi,
  },
  {
    id: 'destructive-disk',
    category: 'destructive',
    severity: 'blocking',
    description: 'Raw disk / filesystem destruction (mkfs, dd, fork bomb, > /dev/sd*)',
    regex: /\bmkfs(\.\w+)?\b|\bdd\s+if=|:\(\)\s*\{\s*:\|:&\s*\}\s*;:|>\s*\/dev\/sd[a-z]/gi,
  },
  {
    id: 'destructive-s3',
    category: 'destructive',
    severity: 'blocking',
    description: 'Destructive S3 op (sync --delete / rm --recursive)',
    regex: /\baws\s+s3\s+(sync\b[^\n]*--delete|rm\b[^\n]*--recursive)/gi,
  },
  {
    id: 'destructive-sql',
    category: 'destructive',
    severity: 'blocking',
    description: 'Destructive SQL (DROP/TRUNCATE TABLE/DATABASE)',
    regex: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/gi,
  },
  {
    id: 'broad-chmod',
    category: 'destructive',
    severity: 'advisory',
    description: 'Over-broad permission change (chmod 777 / -R 777)',
    regex: /\bchmod\s+(-R\s+)?0?777\b/gi,
  },
  // --- remote-code-execution / install-from-url ---
  {
    id: 'curl-pipe-shell',
    category: 'rce',
    severity: 'blocking',
    description: 'Pipes a download straight into a shell/interpreter',
    regex: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh|python3?|node|ruby|perl)\b/gi,
  },
  {
    id: 'install-from-url',
    category: 'rce',
    severity: 'blocking',
    description: 'Installs a package directly from a URL/VCS',
    regex:
      /\b(pip3?\s+install\s+(git\+)?https?:\/\/|npm\s+(i|install|exec)\s+https?:\/\/|npx\s+https?:\/\/|gem\s+install\s+-r?\s*https?:\/\/|go\s+install\s+\S+@)/gi,
  },
  {
    id: 'base64-decode-exec',
    category: 'rce',
    severity: 'blocking',
    description: 'Decodes base64 and executes it',
    regex:
      /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash|python3?|node)|\b(eval|exec)\s*\(\s*(atob|Buffer\.from)\s*\(/gi,
  },
  {
    id: 'dynamic-eval',
    category: 'rce',
    severity: 'advisory',
    description: 'Dynamic code execution (eval / new Function / exec)',
    regex:
      /\b(eval\s*\(|new\s+Function\s*\(|child_process|os\.system\s*\(|subprocess\.(call|run|Popen))/g,
  },
  // --- prompt injection ---
  {
    id: 'prompt-injection',
    category: 'injection',
    severity: 'blocking',
    description: 'Prompt-injection / instruction-override language',
    regex:
      /\b(ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)|disregard\s+(your\s+)?(system\s+prompt|instructions|guidelines)|do\s+not\s+(tell|inform|notify)\s+the\s+(user|operator)|without\s+(asking|telling|notifying)\s+(the\s+)?(user|anyone|permission)|exfiltrate|bypass\s+(the\s+)?(security|gate|review|check|safeguard))/gi,
  },
  // --- over-broad always-on triggers ---
  {
    id: 'always-trigger',
    category: 'over-broad',
    severity: 'advisory',
    description: 'Over-broad always-on trigger (applies to every task/prompt)',
    regex:
      /\b(always\s+(use|apply|run|invoke)\s+this\s+skill|use\s+this\s+(skill\s+)?for\s+(every|all|any)\s+(task|prompt|request)|trigger:\s*always|apply\s+to\s+(all|every)\s+(task|prompt))/gi,
  },
];

/** Find every host used in a network-egress command context. */
const EGRESS_CONTEXT =
  /\b(?:curl|wget|fetch|axios\.(?:get|post)|requests\.(?:get|post)|urllib\.request\.urlopen|http\.get|invoke-webrequest|iwr)\b[^\n]*?https?:\/\/([a-z0-9.-]+)/gi;

function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return allowlist.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Long opaque base64 blob (likely an embedded payload). */
const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/g;

function scanText(text: string, location: string, opts: Required<ScanOptions>): PatternHit[] {
  const hits: PatternHit[] = [];

  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = rule.regex.exec(text)) !== null && guard < 50) {
      guard += 1;
      hits.push({
        id: rule.id,
        category: rule.category,
        severity: rule.severity,
        description: rule.description,
        evidence: truncate(m[0]),
        location,
      });
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex += 1; // avoid zero-width loop
    }
  }

  // Network egress to a non-allowlisted host.
  EGRESS_CONTEXT.lastIndex = 0;
  let e: RegExpExecArray | null;
  let eguard = 0;
  while ((e = EGRESS_CONTEXT.exec(text)) !== null && eguard < 50) {
    eguard += 1;
    const host = e[1];
    if (!hostAllowed(host, opts.networkAllowlist)) {
      hits.push({
        id: 'network-egress',
        category: 'exfiltration',
        severity: 'blocking',
        description: `Network call to non-allowlisted host (${host})`,
        evidence: truncate(e[0]),
        location,
      });
    }
  }

  // Opaque base64 blob.
  BASE64_BLOB.lastIndex = 0;
  let b: RegExpExecArray | null;
  let bguard = 0;
  while ((b = BASE64_BLOB.exec(text)) !== null && bguard < 20) {
    bguard += 1;
    hits.push({
      id: 'base64-blob',
      category: 'rce',
      severity: 'advisory',
      description: 'Long opaque base64 blob (possible embedded payload)',
      evidence: `${b[0].slice(0, 40)}… (${b[0].length} chars)`,
      location,
    });
  }

  return hits;
}

/**
 * Scan a skill's body and any bundled scripts. Returns the worst-case
 * `securityStatus` plus every pattern hit (so the inbox can show the curator
 * exactly what tripped the gate). Pure: same input → same verdict; never runs
 * the content.
 */
export function scanSkill(input: ScanInput, options: ScanOptions = {}): ScanResult {
  const opts: Required<ScanOptions> = {
    networkAllowlist: options.networkAllowlist ?? [...DEFAULT_NETWORK_ALLOWLIST],
  };

  const patternsHit: PatternHit[] = [
    ...scanText(input.body ?? '', 'body', opts),
    ...(input.scripts ?? []).flatMap((s) => scanText(s.content ?? '', s.path, opts)),
  ];

  const hasBlocking = patternsHit.some((h) => h.severity === 'blocking');
  const hasAdvisory = patternsHit.some((h) => h.severity === 'advisory');
  const securityStatus: ScanResult['securityStatus'] = hasBlocking
    ? 'quarantined'
    : hasAdvisory
      ? 'flagged'
      : 'clean';

  return { securityStatus, patternsHit };
}
