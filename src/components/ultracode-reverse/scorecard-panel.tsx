'use client';

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
import type { UltracodeRun, UltracodeScorecard } from '@/types/ultracode-run';
import type { Verdict } from '@/types/scorecard';

function verdictGlyph(score: number): Verdict {
  if (score >= 0.95) return '🟢';
  if (score >= 0.5) return '🟡';
  return '🔴';
}

function MetricTable({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-medium">{title}</h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Metric</TableHead>
            <TableHead className="w-24 text-right">Score</TableHead>
            <TableHead className="w-16 text-center">Verdict</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([k, v]) => (
            <TableRow key={k}>
              <TableCell className="font-mono text-xs">{k}</TableCell>
              <TableCell className="text-right tabular-nums">{v.toFixed(3)}</TableCell>
              <TableCell className="text-center">{verdictGlyph(v)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Pending({ status }: { status: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scorecard</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Awaiting halt — the daemon scores both plans once they reach “plan produced”. Current
          status: <span className="font-mono">{status}</span>.
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
  if (!run) return null;
  if (!scorecard) return <Pending status={run.status} />;

  const structuralRows: Array<[string, number]> = [
    ...Object.entries(scorecard.structural.perMetric),
    ['aggregate', scorecard.structural.score],
  ];
  const guardrailRows: Array<[string, number]> = scorecard.guardrail
    ? [...Object.entries(scorecard.guardrail.sub), ['uplift', scorecard.guardrail.uplift]]
    : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Scorecard</CardTitle>
        <div className="flex items-center gap-2">
          {scorecard.verdict && <Badge variant="secondary">{scorecard.verdict}</Badge>}
          <span className="text-xs text-muted-foreground">
            case1: {run.case1Pattern ?? '—'} · case2: {run.case2Pattern ?? '—'}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <MetricTable
          title="Structural diff (planning quality — should match)"
          rows={structuralRows}
        />

        {guardrailRows.length > 0 && (
          <>
            <Separator />
            <div>
              <MetricTable
                title="Guardrail uplift — Case-2 axis (Case 1 has no guardrails by design)"
                rows={guardrailRows}
              />
            </div>
          </>
        )}

        {scorecard.judge && (
          <>
            <Separator />
            <div>
              <h4 className="mb-2 text-sm font-medium">Judge panel (blind A/B)</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Axis</TableHead>
                    <TableHead className="w-20 text-right">Case 1</TableHead>
                    <TableHead className="w-20 text-right">Case 2</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(scorecard.judge.perAxis).map(([axis, v]) => (
                    <TableRow key={axis}>
                      <TableCell className="font-mono text-xs">{axis}</TableCell>
                      <TableCell className="text-right tabular-nums">{v.case1 ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{v.case2 ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        {scorecard.observations && scorecard.observations.length > 0 && (
          <>
            <Separator />
            <div>
              <h4 className="mb-2 text-sm font-medium">Observations</h4>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {scorecard.observations.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Confound: <span className="font-mono">{run.confound}</span>
        </p>
      </CardContent>
    </Card>
  );
}
