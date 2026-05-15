/**
 * Phase Gate Enforcement
 *
 * Phase gate checker for the Mycelium 7-phase model:
 *   Discovery -> Planning -> Solutioning -> Implementation -> QA -> Release -> Support
 *
 * Soft gates -- returns warnings, never blocks. This is personal developer
 * tooling, not enterprise governance. The system warns when you skip ahead
 * so you can make that choice consciously rather than accidentally.
 *
 * Usage:
 *   import { checkPhaseGate, getPhaseForArticleType } from './phase-gates.mjs';
 *   const result = await checkPhaseGate('planning', 'solutioning', driver);
 *
 * CLI:
 *   node phase-gates.mjs --from <phase> --to <phase> --project <id>
 */

import { createDriver } from './memgraph-driver.mjs';

// ── Phase Definitions ──

/**
 * The 7 phases of the Mycelium model, in order.
 */
export const PHASES = [
  'discovery',
  'planning',
  'solutioning',
  'implementation',
  'qa',
  'release',
  'support',
];

/**
 * Maps article types to their corresponding phase.
 * Used to infer which phase a new node belongs to, enabling
 * automatic gate checks when nodes are created.
 */
export const ARTICLE_TYPE_TO_PHASE = {
  // Discovery
  brainstorm: 'discovery',
  brief: 'discovery',
  research: 'discovery',
  evidence: 'discovery',
  'competitive-analysis': 'discovery',

  // Planning
  prd: 'planning',
  requirement: 'planning',
  'epic-plan': 'planning',
  'story-plan': 'planning',
  risk: 'planning',

  // Solutioning
  architecture: 'solutioning',
  'tech-spec': 'solutioning',
  'api-spec': 'solutioning',
  'data-model': 'solutioning',
  adr: 'solutioning',
  'ux-spec': 'solutioning',
  design: 'solutioning',
  'user-journey': 'solutioning',

  // Implementation
  code: 'implementation',

  // QA
  'test-plan': 'qa',
  'test-result': 'qa',
  'visual-qa-report': 'qa',

  // Release
  'deployment-record': 'release',
  'release-notes': 'release',

  // Support
  'bug-report': 'support',
  'feature-request': 'support',
  'evolution-plan': 'support',
};

// ── Gate Rules Configuration ──

/**
 * Phase gate rules. Each gate defines:
 *   - from: source phase
 *   - to: target phase
 *   - requirements: array of checks, each with:
 *     - types: node types to check
 *     - minMaturity: minimum maturity score required
 *     - minCount: minimum number of qualifying nodes (default 1)
 *     - aggregate: 'avg' to check average maturity across all nodes of type
 *     - description: human-readable description of the requirement
 *
 * From architecture doc section 6.3.
 */
export const GATE_RULES = [
  {
    from: 'discovery',
    to: 'planning',
    requirements: [
      {
        types: ['brainstorm', 'brief'],
        minMaturity: 0.4,
        minCount: 1,
        description: 'At least 1 brainstorm or brief node at maturity >= 0.4',
      },
    ],
  },
  {
    from: 'planning',
    to: 'solutioning',
    requirements: [
      {
        types: ['prd'],
        minMaturity: 0.6,
        minCount: 1,
        description: 'PRD node at maturity >= 0.6',
      },
      {
        types: ['requirement'],
        minMaturity: 0.4,
        minCount: 1,
        description: 'At least 1 requirement node at maturity >= 0.4',
      },
    ],
  },
  {
    from: 'solutioning',
    to: 'implementation',
    requirements: [
      {
        types: ['architecture'],
        minMaturity: 0.6,
        minCount: 1,
        description: 'Architecture node at maturity >= 0.6',
      },
      {
        types: ['tech-spec'],
        minMaturity: 0.4,
        minCount: 1,
        description: 'Tech spec node at maturity >= 0.4',
      },
    ],
  },
  {
    from: 'implementation',
    to: 'qa',
    requirements: [
      {
        types: ['code'],
        minMaturity: 0.6,
        aggregate: 'avg',
        description: 'Code nodes average maturity >= 0.6',
      },
    ],
  },
  {
    from: 'qa',
    to: 'release',
    requirements: [
      {
        types: ['test-plan'],
        minMaturity: 0.6,
        minCount: 1,
        description: 'Test plan node at maturity >= 0.6',
      },
    ],
  },
  {
    from: 'release',
    to: 'support',
    requirements: [
      {
        types: ['deployment-record'],
        minMaturity: 0.6,
        minCount: 1,
        description: 'Deployment record exists (deployment successful)',
      },
      {
        types: ['release-notes'],
        minMaturity: 0.4,
        minCount: 1,
        description: 'Release notes generated',
      },
    ],
  },
];

// ── Gate Rule Lookup ──

/**
 * Get gate requirements for a specific phase transition.
 *
 * @param {string} fromPhase - Source phase
 * @param {string} toPhase - Target phase
 * @returns {Array|null} Gate requirements or null if no gate defined
 */
export function getGateRequirements(fromPhase, toPhase) {
  const gate = GATE_RULES.find(g => g.from === fromPhase && g.to === toPhase);
  return gate ? gate.requirements : null;
}

/**
 * Get the phase for a given article type.
 * Used to infer which phase a new node belongs to.
 *
 * @param {string} articleType
 * @returns {string|null}
 */
export function getPhaseForArticleType(articleType) {
  return ARTICLE_TYPE_TO_PHASE[articleType] || null;
}

/**
 * Get the upstream phase that must be satisfied before entering the target phase.
 *
 * @param {string} targetPhase
 * @returns {string|null} The upstream phase, or null if no gate required
 */
export function getUpstreamPhase(targetPhase) {
  const idx = PHASES.indexOf(targetPhase);
  if (idx <= 0) return null;
  return PHASES[idx - 1];
}

/**
 * Determine which gate to check when creating a node of a given article type.
 * Returns the fromPhase -> toPhase transition to check.
 *
 * @param {string} articleType
 * @returns {{ fromPhase: string, toPhase: string }|null}
 */
export function getGateForArticleType(articleType) {
  const toPhase = getPhaseForArticleType(articleType);
  if (!toPhase) return null;
  const fromPhase = getUpstreamPhase(toPhase);
  if (!fromPhase) return null;
  return { fromPhase, toPhase };
}

// ── Gate Check Logic ──

/**
 * Check a single gate requirement against Memgraph.
 *
 * @param {Object} requirement - Gate requirement rule
 * @param {string} projectId
 * @param {import('neo4j-driver').Session} session - Memgraph session
 * @returns {Promise<{ passed: boolean, actual: Object, missingNodes: Array }>}
 */
async function checkRequirement(requirement, projectId, session) {
  const { types, minMaturity, minCount, aggregate } = requirement;

  // Query for qualifying nodes
  const result = await session.run(
    `MATCH (n:Node {projectId: $projectId, status: 'active'})
     WHERE n.type IN $types
     RETURN n.nodeId AS nodeId, n.type AS type, n.title AS title, n.maturity AS maturity
     ORDER BY n.maturity DESC`,
    { projectId, types }
  );

  const nodes = result.records.map(r => ({
    nodeId: r.get('nodeId'),
    type: r.get('type'),
    title: r.get('title'),
    maturity: typeof r.get('maturity') === 'object'
      ? r.get('maturity').toNumber()
      : r.get('maturity') || 0,
  }));

  // Aggregate check
  if (aggregate === 'avg') {
    if (nodes.length === 0) {
      return {
        passed: false,
        actual: { count: 0, avgMaturity: 0 },
        missingNodes: [{ expected: types.join('/'), reason: 'No nodes found' }],
      };
    }
    const avgMaturity = nodes.reduce((sum, n) => sum + n.maturity, 0) / nodes.length;
    const roundedAvg = Math.round(avgMaturity * 100) / 100;
    const passed = roundedAvg >= minMaturity;

    const belowThreshold = nodes.filter(n => n.maturity < minMaturity);

    return {
      passed,
      actual: { count: nodes.length, avgMaturity: roundedAvg },
      missingNodes: passed ? [] : belowThreshold.map(n => ({
        nodeId: n.nodeId,
        currentMaturity: n.maturity,
        requiredMaturity: minMaturity,
        reason: `Maturity ${n.maturity} < ${minMaturity}`,
      })),
    };
  }

  // Count + maturity check
  const qualifying = nodes.filter(n => n.maturity >= minMaturity);
  const effectiveMinCount = minCount || 1;
  const passed = qualifying.length >= effectiveMinCount;

  const belowThreshold = nodes.filter(n => n.maturity < minMaturity);

  return {
    passed,
    actual: { count: qualifying.length, totalNodes: nodes.length },
    missingNodes: passed ? [] : [
      ...(nodes.length === 0
        ? [{ expected: types.join('/'), reason: `No ${types.join('/')} nodes found` }]
        : []),
      ...belowThreshold.map(n => ({
        nodeId: n.nodeId,
        currentMaturity: n.maturity,
        requiredMaturity: minMaturity,
        reason: `Maturity ${n.maturity} < required ${minMaturity}`,
      })),
      ...(qualifying.length < effectiveMinCount && nodes.length > 0
        ? [{ expected: types.join('/'), reason: `Only ${qualifying.length} of ${effectiveMinCount} required nodes meet maturity threshold` }]
        : []),
    ],
  };
}

/**
 * Check a phase gate transition.
 *
 * This is the main export. Queries Memgraph for node maturity in the
 * prerequisite phase. Returns whether the gate passed and any warnings.
 *
 * Soft gate -- returns warnings, never blocks.
 *
 * @param {string} fromPhase - Source phase (e.g., 'planning')
 * @param {string} toPhase - Target phase (e.g., 'solutioning')
 * @param {import('neo4j-driver').Driver} driver - Neo4j/Memgraph driver
 * @param {Object} [opts]
 * @param {string} [opts.projectId] - Project identifier (default: first found)
 * @returns {Promise<{
 *   passed: boolean,
 *   fromPhase: string,
 *   toPhase: string,
 *   warnings: Array<{ rule: string, actual: Object, required: Object, missingNodes: Array }>,
 *   missing: Array<{ description: string, missingNodes: Array }>
 * }>}
 */
export async function checkPhaseGate(fromPhase, toPhase, driver, opts = {}) {
  const requirements = getGateRequirements(fromPhase, toPhase);

  if (!requirements) {
    return {
      passed: true,
      fromPhase,
      toPhase,
      warnings: [],
      missing: [],
    };
  }

  const projectId = opts.projectId || 'default';
  const session = driver.session();
  const warnings = [];
  const missing = [];
  let allPassed = true;

  try {
    for (const req of requirements) {
      const result = await checkRequirement(req, projectId, session);

      if (!result.passed) {
        allPassed = false;
        warnings.push({
          rule: req.description,
          actual: result.actual,
          required: { types: req.types, minMaturity: req.minMaturity, minCount: req.minCount || 1 },
          missingNodes: result.missingNodes,
        });
        missing.push({
          description: req.description,
          missingNodes: result.missingNodes,
        });
      }
    }
  } finally {
    await session.close();
  }

  return {
    passed: allPassed,
    fromPhase,
    toPhase,
    warnings,
    missing,
  };
}

// ── Warning Formatting ──

/**
 * Format gate check result as a human-readable warning message.
 *
 * @param {Object} gateResult - Result from checkPhaseGate
 * @returns {string}
 */
export function formatGateWarning(gateResult) {
  if (gateResult.passed) {
    return `Phase gate ${gateResult.fromPhase} -> ${gateResult.toPhase}: PASSED`;
  }

  const lines = [
    `Phase gate warning: ${gateResult.fromPhase} -> ${gateResult.toPhase} -- Missing:`,
  ];

  for (const w of gateResult.warnings) {
    lines.push(`  - ${w.rule}`);
    lines.push(`    Actual: ${JSON.stringify(w.actual)}`);
    if (w.missingNodes.length > 0) {
      for (const mn of w.missingNodes) {
        if (mn.nodeId) {
          lines.push(`    Node: ${mn.nodeId} (maturity ${mn.currentMaturity}, needs ${mn.requiredMaturity})`);
        } else {
          lines.push(`    ${mn.reason || mn.expected}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Convert gate result to ValidationResult format for pipeline job storage.
 * Uses the existing ValidationResult interface from agent-orchestrator.ts.
 *
 * @param {Object} gateResult
 * @returns {Array<{ label: string, passed: boolean, details: string }>}
 */
export function toValidationResults(gateResult) {
  if (gateResult.passed) {
    return [{
      label: `Phase gate: ${gateResult.fromPhase} -> ${gateResult.toPhase}`,
      passed: true,
      details: 'All gate requirements met',
    }];
  }

  return gateResult.warnings.map(w => ({
    label: `Phase gate: ${gateResult.fromPhase} -> ${gateResult.toPhase}`,
    passed: false,
    details: `${w.rule} | Actual: ${JSON.stringify(w.actual)} | Missing: ${w.missingNodes.map(m => m.reason || m.nodeId).join('; ')}`,
  }));
}

// ── Full Gate Status Report ──

/**
 * Generate a full gate status report for all phase transitions.
 *
 * @param {import('neo4j-driver').Driver} driver
 * @param {Object} opts
 * @param {string} opts.projectId
 * @returns {Promise<Array<{ fromPhase: string, toPhase: string, passed: boolean, warnings: Array }>>}
 */
export async function fullGateReport(driver, opts = {}) {
  const results = [];

  for (const gate of GATE_RULES) {
    const result = await checkPhaseGate(gate.from, gate.to, driver, opts);
    results.push(result);
  }

  return results;
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);
  let fromPhase = null;
  let toPhase = null;
  let projectId = 'default';
  let fullReport = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) fromPhase = args[++i];
    else if (args[i] === '--to' && args[i + 1]) toPhase = args[++i];
    else if (args[i] === '--project' && args[i + 1]) projectId = args[++i];
    else if (args[i] === '--full') fullReport = true;
  }

  if (!fullReport && (!fromPhase || !toPhase)) {
    console.error('Usage: node phase-gates.mjs --from <phase> --to <phase> --project <id>');
    console.error('       node phase-gates.mjs --full --project <id>');
    process.exit(1);
  }

  const driver = createDriver();

  try {
    if (fullReport) {
      console.log(`[phase-gates] Full gate report for project: ${projectId}\n`);
      const results = await fullGateReport(driver, { projectId });

      for (const result of results) {
        const status = result.passed ? 'PASSED' : 'WARNING';
        console.log(`${result.fromPhase} -> ${result.toPhase}: ${status}`);
        if (!result.passed) {
          console.log(formatGateWarning(result));
        }
        console.log('');
      }
    } else {
      console.log(`[phase-gates] Checking gate: ${fromPhase} -> ${toPhase}`);
      const result = await checkPhaseGate(fromPhase, toPhase, driver, { projectId });

      console.log(formatGateWarning(result));

      if (!result.passed) {
        console.log('\n(Soft gate: pipeline continues despite warnings)');
      }
    }
  } finally {
    await driver.close();
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('phase-gates.mjs') ||
  process.argv[1].endsWith('phase-gates')
);
if (isMain) {
  main().catch(err => {
    console.error(`[phase-gates] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
