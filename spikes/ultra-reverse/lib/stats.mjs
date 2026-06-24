// stats.mjs — tiny distribution helpers (design §9: report distributions, not single runs).

/** @param {number[]} xs @returns {{n:number, mean:number, stdev:number, min:number, max:number}|null} */
export function summarize(xs) {
  const v = (xs || []).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0) return null;
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / n; // population stdev (we have the whole sample)
  return { n, mean: r3(mean), stdev: r3(Math.sqrt(variance)), min: Math.min(...v), max: Math.max(...v) };
}

const r3 = (x) => Math.round(x * 1000) / 1000;
