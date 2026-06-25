'use client';

import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Download } from 'lucide-react';
import { EXPORT_GOALS, GOAL_LABEL, buildExport, type ExportGoal } from '@/lib/ultracode-export';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type {
  UltracodeDecisionPlan,
  UltracodeRun,
  UltracodeScorecard,
} from '@/types/ultracode-run';
import type { Verdict } from '@/types/scorecard';

function verdictGlyph(score: number): Verdict {
  if (score >= 0.95) return '🟢';
  if (score >= 0.5) return '🟡';
  return '🔴';
}

interface Signals {
  pattern: string;
  phases: number;
  agents: number;
  fanout: string;
  verify: string;
  schema: string;
  schemaPct: number;
  quality: string;
  reduce: number;
  earlyExit: string;
}

function planSignals(plan?: UltracodeDecisionPlan): Signals | null {
  if (!plan) return null;
  const agents = plan.phases.flatMap((p) => p.agents);
  const withSchema = agents.filter((a) => a.hasSchema).length;
  const fanPhases = plan.phases.filter((p) => p.fanOut);
  const axes = [...new Set(fanPhases.map((p) => p.fanOut!.axis))];
  return {
    pattern: plan.pattern,
    phases: plan.phases.length,
    agents: agents.length,
    fanout: fanPhases.length ? `${fanPhases.length} (${axes.join(', ')})` : 'none',
    verify: plan.verify?.present ? plan.verify.kind : 'none',
    schema: agents.length
      ? `${withSchema}/${agents.length} (${Math.round((100 * withSchema) / agents.length)}%)`
      : '—',
    schemaPct: agents.length ? withSchema / agents.length : 0,
    quality: plan.qualityPatterns.length ? plan.qualityPatterns.join(', ') : 'none',
    reduce: plan.reduceSteps,
    earlyExit: plan.earlyExit ? 'yes' : 'no',
  };
}

/** Plain-English read of the most decision-relevant differences. */
function keyDifferences(c1: Signals, c2: Signals): string[] {
  const out: string[] = [];
  if (c1.verify !== c2.verify) {
    const stronger =
      c1.verify !== 'none' && c2.verify === 'none'
        ? 'Case 1'
        : c2.verify !== 'none' && c1.verify === 'none'
          ? 'Case 2'
          : null;
    out.push(
      stronger
        ? `${stronger} adds a verification stage (${stronger === 'Case 1' ? c1.verify : c2.verify}); the other has none.`
        : `Different verification: Case 1 = ${c1.verify}, Case 2 = ${c2.verify}.`,
    );
  }
  if (Math.abs(c1.schemaPct - c2.schemaPct) >= 0.2) {
    const s = c1.schemaPct > c2.schemaPct ? 'Case 1' : 'Case 2';
    out.push(`${s} has stronger schema discipline (${c1.schema} vs ${c2.schema}).`);
  }
  if (c1.agents !== c2.agents) {
    const s = c1.agents > c2.agents ? 'Case 1' : 'Case 2';
    out.push(
      `${s} decomposes wider — ${Math.max(c1.agents, c2.agents)} vs ${Math.min(c1.agents, c2.agents)} subagents.`,
    );
  }
  if (c1.quality !== c2.quality) {
    out.push(`Quality patterns differ — Case 1: ${c1.quality}; Case 2: ${c2.quality}.`);
  }
  if (out.length === 0)
    out.push('The two plans are structurally equivalent on every tracked dimension.');
  return out;
}

function CompareRow({ label, a, b }: { label: string; a: string | number; b: string | number }) {
  const differ = String(a) !== String(b);
  return (
    <TableRow className={cn(differ && 'bg-warning/5')}>
      <TableCell className="text-xs font-medium">
        {label}
        {differ && <span className="ml-1 text-warning">Δ</span>}
      </TableCell>
      <TableCell className="text-xs">{a}</TableCell>
      <TableCell className="text-xs">{b}</TableCell>
    </TableRow>
  );
}

/** Compound-goal JSON export for the prompt-improvement loop. */
function ExportBar({ run }: { run: UltracodeRun }) {
  const [goals, setGoals] = useState<ExportGoal[]>(['replicate']);
  const [copied, setCopied] = useState(false);
  const toggle = (g: ExportGoal) =>
    setGoals((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));
  const json = () => JSON.stringify(buildExport(run, goals, new Date().toISOString()), null, 2);
  const download = () => {
    const blob = new Blob([json()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ultracode-${run.runId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = () =>
    navigator.clipboard?.writeText(json()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  const btn =
    'flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground';
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Export for prompt improvement</span>
        <div className="flex items-center gap-1.5">
          <button onClick={copy} className={btn} disabled={goals.length === 0}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
          <button onClick={download} className={btn} disabled={goals.length === 0}>
            <Download className="h-3 w-3" />
            Download
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Goals (compound):</span>
        {EXPORT_GOALS.map((g) => (
          <button
            key={g}
            onClick={() => toggle(g)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              goals.includes(g)
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-muted/50',
            )}
          >
            {GOAL_LABEL[g]}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        One JSON per run: both plans + scripts + the Case-2 meta-prompt + signals, plus a framing
        per selected goal (objective + directional dimensions + ranked asks) for your expert agent.
      </p>
    </div>
  );
}

function Pending({ status }: { status: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Comparison</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Awaiting halt — both plans are compared once they reach “plan produced”. Current status:{' '}
          <span className="font-mono">{status}</span>.
        </p>
      </CardContent>
    </Card>
  );
}

interface ScorecardPanelProps {
  run: UltracodeRun | undefined;
  scorecard: UltracodeScorecard | null | undefined;
}

export function ScorecardPanel({ run, scorecard }: ScorecardPanelProps) {
  const [showMetrics, setShowMetrics] = useState(false);
  if (!run) return null;
  if (!scorecard) return <Pending status={run.status} />;

  const c1 = planSignals(run.case1Plan);
  const c2 = planSignals(run.case2Plan);

  const structuralRows: Array<[string, number]> = [
    ...Object.entries(scorecard.structural.perMetric),
    ['aggregate', scorecard.structural.score],
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Plan comparison</CardTitle>
        {scorecard.verdict && <Badge variant="secondary">{scorecard.verdict}</Badge>}
      </CardHeader>
      <CardContent className="space-y-5">
        <ExportBar run={run} />

        {c1 && c2 ? (
          <>
            <div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-40">Dimension</TableHead>
                    <TableHead>Case 1 · native ultracode</TableHead>
                    <TableHead>Case 2 · our meta-prompt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <CompareRow label="Pattern" a={c1.pattern} b={c2.pattern} />
                  <CompareRow label="Phases" a={c1.phases} b={c2.phases} />
                  <CompareRow label="Subagents" a={c1.agents} b={c2.agents} />
                  <CompareRow label="Fan-out phases" a={c1.fanout} b={c2.fanout} />
                  <CompareRow label="Verification" a={c1.verify} b={c2.verify} />
                  <CompareRow label="Schema discipline" a={c1.schema} b={c2.schema} />
                  <CompareRow label="Quality patterns" a={c1.quality} b={c2.quality} />
                  <CompareRow label="Reduce steps" a={c1.reduce} b={c2.reduce} />
                  <CompareRow label="Early-exit guard" a={c1.earlyExit} b={c2.earlyExit} />
                </TableBody>
              </Table>
            </div>
            <div>
              <h4 className="mb-2 text-sm font-medium">What differs</h4>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {keyDifferences(c1, c2).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Side-by-side comparison isn’t available for this run (it predates plan capture). Run a
            new bench to get the full comparison.
          </p>
        )}

        <Separator />

        {/* Demoted: the abstract similarity metrics, collapsed by default. */}
        <div>
          <button
            onClick={() => setShowMetrics((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {showMetrics ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Similarity metrics — how closely Case 2 mirrors Case 1 (aggregate{' '}
            {scorecard.structural.score.toFixed(2)})
          </button>
          {showMetrics && (
            <div className="mt-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead className="w-24 text-right">Score</TableHead>
                    <TableHead className="w-16 text-center">Verdict</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {structuralRows.map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="font-mono text-xs">{k}</TableCell>
                      <TableCell className="text-right tabular-nums">{v.toFixed(3)}</TableCell>
                      <TableCell className="text-center">{verdictGlyph(v)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">
                These measure structural <em>similarity</em>, not which plan is better — a low score
                just means the two plans took different (possibly both-valid) shapes.
              </p>
            </div>
          )}
        </div>

        {scorecard.observations && scorecard.observations.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Confound: <span className="font-mono">{run.confound}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
