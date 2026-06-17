/**
 * text-diff.ts — Skills Institution, Story 3.2 (2026-06-17).
 *
 * A tiny, dependency-free line-level diff (LCS) for the curation Inbox: the
 * operator triages on the gist, then decides on the DIFF of a proposed skill
 * body vs the current registry body. We deliberately avoid pulling in a diff
 * dependency for one screen — this LCS line-diff is ~50 lines, pure, and
 * unit-tested.
 *
 * Returns an ordered list of lines tagged `ctx` (unchanged), `add`, or `del` —
 * the shape the `SkillDiffViewer` (Story 3.3) renders directly. Not a full
 * unified diff with @@ hunks (overkill for short SKILL.md bodies); a flat
 * tagged-line list reads fine for the sizes involved.
 */

export type DiffLineType = 'ctx' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffSummary {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/**
 * Line-level LCS diff. `a` is the old (current registry) body, `b` the new
 * (proposed) body. Deletions are emitted before additions at each divergence.
 */
export function lineDiff(a: string, b: string): DiffSummary {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const n = aLines.length;
  const m = bLines.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        aLines[i] === bLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      lines.push({ type: 'ctx', text: aLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: 'del', text: aLines[i] });
      removed++;
      i++;
    } else {
      lines.push({ type: 'add', text: bLines[j] });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: aLines[i++] });
    removed++;
  }
  while (j < m) {
    lines.push({ type: 'add', text: bLines[j++] });
    added++;
  }

  return { lines, added, removed };
}
