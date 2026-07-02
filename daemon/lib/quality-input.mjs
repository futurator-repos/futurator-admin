// quality-input — W2.1. Turn a story's run bound-ACs into the coverage/pass
// P-band numbers that `evaluateQualityGate` consumes. Pure, no I/O.
//
// The P-band comes from `riskTag` (stamped by the W1.3 Cartographer). SAFETY
// (safety review): a band with ZERO ACs is VACUOUSLY satisfied (→ 100), never 0
// — otherwise a plan with no P0 ACs (or with the Cartographer off, so no riskTag
// at all) would compute cov.p0=0 and spuriously FAIL. Manual ACs are excluded
// (human-gated, not part of the deterministic coverage math).

/** Coverage% (has a bound test) + pass% (test passing) for one band; vacuous → 100. */
function band(acs, inBand) {
  const members = acs.filter(inBand);
  const denom = members.length;
  if (denom === 0) return { coverage: 100, pass: 100 };
  const bound = members.filter((a) => a.testBinding && a.testBinding.status !== 'unbound').length;
  const passing = members.filter((a) => a.testBinding && a.testBinding.status === 'passing').length;
  return { coverage: (bound / denom) * 100, pass: (passing / denom) * 100 };
}

/**
 * @param {object[]} acceptanceCriteria — run bound ACs (each with testBinding + optional riskTag)
 * @returns {{ coverage: {p0:number,p1:number,overall:number}, pass: {p0:number,p1:number,overall:number} }}
 */
export function computeQualityInput(acceptanceCriteria = []) {
  const acs = acceptanceCriteria.filter(
    (a) => a.verify !== 'manual' && a.testBinding?.testKind !== 'manual',
  );
  const p0 = band(acs, (a) => a.riskTag === 'P0');
  const p1 = band(acs, (a) => a.riskTag === 'P1');
  const all = band(acs, () => true);
  return {
    coverage: { p0: p0.coverage, p1: p1.coverage, overall: all.coverage },
    pass: { p0: p0.pass, p1: p1.pass, overall: all.pass },
  };
}
