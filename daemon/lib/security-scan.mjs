/**
 * security-scan.mjs — Skills Institution, Story 1.3 (2026-06-17). Gate-1 (daemon).
 *
 * DAEMON MIRROR of `functions/shared/skill-gate/security-scan.ts`. The daemon
 * ships only `daemon/` to EC2 (rsync excludes `functions/`), so it cannot import
 * the authoritative TS scanner at runtime — this is a faithful port kept honest
 * by `daemon/lib/__tests__/security-scan-parity.test.mjs`, which runs the SAME
 * corpus through BOTH and asserts identical verdicts. The TS file is the source
 * of truth; when you change a rule there, change it here and the parity test
 * proves they agree.
 *
 * Used by `reflector-apply.mjs` to scan an app-evolved skill body BEFORE it is
 * committed into an app — a malicious reflection must not write executable
 * instructions into a repo. Pure; never executes the content.
 */

/** @typedef {{ id: string, category: string, severity: 'blocking'|'advisory', description: string, evidence: string, location: string }} PatternHit */

export const DEFAULT_NETWORK_ALLOWLIST = Object.freeze([
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
function truncate(s) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EVIDENCE ? `${flat.slice(0, MAX_EVIDENCE)}…` : flat;
}

const RULES = [
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
  {
    id: 'prompt-injection',
    category: 'injection',
    severity: 'blocking',
    description: 'Prompt-injection / instruction-override language',
    regex:
      /\b(ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)|disregard\s+(your\s+)?(system\s+prompt|instructions|guidelines)|do\s+not\s+(tell|inform|notify)\s+the\s+(user|operator)|without\s+(asking|telling|notifying)\s+(the\s+)?(user|anyone|permission)|exfiltrate|bypass\s+(the\s+)?(security|gate|review|check|safeguard))/gi,
  },
  {
    id: 'always-trigger',
    category: 'over-broad',
    severity: 'advisory',
    description: 'Over-broad always-on trigger (applies to every task/prompt)',
    regex:
      /\b(always\s+(use|apply|run|invoke)\s+this\s+skill|use\s+this\s+(skill\s+)?for\s+(every|all|any)\s+(task|prompt|request)|trigger:\s*always|apply\s+to\s+(all|every)\s+(task|prompt))/gi,
  },
];

const EGRESS_CONTEXT =
  /\b(?:curl|wget|fetch|axios\.(?:get|post)|requests\.(?:get|post)|urllib\.request\.urlopen|http\.get|invoke-webrequest|iwr)\b[^\n]*?https?:\/\/([a-z0-9.-]+)/gi;

function hostAllowed(host, allowlist) {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return allowlist.some((a) => h === a || h.endsWith(`.${a}`));
}

const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/g;

function scanText(text, location, allowlist) {
  /** @type {PatternHit[]} */
  const hits = [];

  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let m;
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
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex += 1;
    }
  }

  EGRESS_CONTEXT.lastIndex = 0;
  let e;
  let eguard = 0;
  while ((e = EGRESS_CONTEXT.exec(text)) !== null && eguard < 50) {
    eguard += 1;
    const host = e[1];
    if (!hostAllowed(host, allowlist)) {
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

  BASE64_BLOB.lastIndex = 0;
  let b;
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
 * Scan a skill body (+ optional bundled scripts). Mirror of the TS `scanSkill`.
 *
 * @param {{ body: string, scripts?: Array<{ path: string, content: string }> }} input
 * @param {{ networkAllowlist?: string[] }} [options]
 * @returns {{ securityStatus: 'clean'|'flagged'|'quarantined', patternsHit: PatternHit[] }}
 */
export function scanSkill(input, options = {}) {
  const allowlist = options.networkAllowlist ?? [...DEFAULT_NETWORK_ALLOWLIST];
  const patternsHit = [
    ...scanText(input.body ?? '', 'body', allowlist),
    ...(input.scripts ?? []).flatMap((s) => scanText(s.content ?? '', s.path, allowlist)),
  ];
  const hasBlocking = patternsHit.some((h) => h.severity === 'blocking');
  const hasAdvisory = patternsHit.some((h) => h.severity === 'advisory');
  const securityStatus = hasBlocking ? 'quarantined' : hasAdvisory ? 'flagged' : 'clean';
  return { securityStatus, patternsHit };
}
