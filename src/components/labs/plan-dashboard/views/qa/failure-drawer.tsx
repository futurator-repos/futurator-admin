'use client';

/**
 * Failure drawer — right-side 480px sliding panel that surfaces drill-down
 * detail for a single failing (or pending) QA item. Drawer content varies by
 * the failure's origin pillar:
 *
 *   AC   → criterion text + PO note + story ref + "Send back" + "View logs"
 *   VQA  → screenshot + expected + observed + CTAs
 *   Gate → test error excerpt + retry history + tamper count + CTAs
 *
 * "Send back to dev" = POST /api/epic-workflows/:id/stories/:storyId/send-back.
 * "View logs" = navigate to Hierarchy with the matching story expanded (logs
 * live in the existing story detail pane under Pipeline Enhancement Plan v2).
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { X, ArrowLeft, Send, FileText, ExternalLink, Loader2 } from 'lucide-react';
import type {
  AcCriterionResult,
  GateWaveRow,
  VqaTestResult,
} from '@/types/qa-report';
import { useSendStoryBack } from '@/hooks/use-qa-report';

export type FailureDrawerItem =
  | { kind: 'ac'; item: AcCriterionResult }
  | { kind: 'vqa'; item: VqaTestResult }
  | { kind: 'gate'; row: GateWaveRow; check: string; cellStatus: string };

interface Props {
  planId: string;
  item: FailureDrawerItem | null;
  onClose: () => void;
}

export function FailureDrawer({ planId, item, onClose }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const sendBack = useSendStoryBack(planId);
  const [note, setNote] = useState('');
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reset the drawer composer state when the user switches failure items.
  // This is a legitimate derived-state sync (external prop → local state),
  // same pattern used in project-selector.tsx.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNote('');
    setSentMsg(null);
  }, [item]);

  if (!item) return null;

  // Default note stub depends on failure kind, fillable by the operator.
  const defaultNote = buildDefaultNote(item);
  const contextStoryId = storyIdOf(item);
  const contextEpicId = epicIdOf(item);

  async function handleSendBack() {
    if (!contextEpicId || !contextStoryId) return;
    const finalNote = note.trim() || defaultNote;
    try {
      const res = await sendBack.mutateAsync({
        epicId: contextEpicId,
        storyId: contextStoryId,
        note: finalNote,
      });
      setSentMsg(
        res.jobId
          ? `Sent back · job ${res.jobId.slice(0, 8)}`
          : res.warning === 'rerun-failed'
            ? 'Status flipped but re-launch failed — retry in Developing'
            : 'Sent back',
      );
    } catch (err) {
      setSentMsg(err instanceof Error ? `Error: ${err.message}` : 'Error');
    }
  }

  function onOpenInHierarchy() {
    if (!contextStoryId) return;
    const sp = new URLSearchParams(params.toString());
    sp.set('stage', 'developing');
    sp.set('subtab', 'hierarchy');
    // Story focus is out-of-scope for v1; Hierarchy opens to the top and the
    // user scrolls — good enough for now.
    router.replace(`/labs/?${sp.toString()}`);
    onClose();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 300,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          background: 'var(--bg-elev)',
          borderLeft: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-20px 0 60px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <span
            style={{
              background: 'var(--destructive)',
              width: 8,
              height: 8,
              borderRadius: '50%',
              marginTop: 7,
              boxShadow: '0 0 10px color-mix(in srgb, var(--destructive) 40%, transparent)',
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.22em',
                marginBottom: 4,
              }}
            >
              {kindLabel(item)}
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: 'var(--foreground)',
                lineHeight: 1.3,
                textWrap: 'pretty',
              }}
            >
              {titleOf(item)}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-mute)',
                marginTop: 6,
                letterSpacing: '0.06em',
              }}
            >
              {subtitleOf(item)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            style={{
              color: 'var(--text-mute)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflow: 'auto', flex: 1 }}>
          {item.kind === 'ac' && <AcDetail item={item.item} />}
          {item.kind === 'vqa' && <VqaDetail item={item.item} />}
          {item.kind === 'gate' && <GateDetail row={item.row} check={item.check} cellStatus={item.cellStatus} />}

          {/* Send-back composer (only when we have a story target) */}
          {contextStoryId && (
            <div style={{ marginTop: 22 }}>
              <SectionLabel>Send back to dev — note (optional)</SectionLabel>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={defaultNote}
                rows={4}
                style={{
                  width: '100%',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '10px 12px',
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-sans)',
                  resize: 'vertical',
                  outline: 'none',
                  marginTop: 6,
                }}
              />
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--text-faint)',
                  marginTop: 6,
                  letterSpacing: '0.04em',
                }}
              >
                The note gets appended to the story description; dev agent reads it on retry.
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {contextStoryId && (
            <button
              type="button"
              onClick={handleSendBack}
              disabled={sendBack.isPending || !!sentMsg}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                padding: '8px 14px',
                borderRadius: 3,
                background: 'color-mix(in srgb, var(--destructive) 12%, transparent)',
                border: '1px solid var(--destructive)',
                color: 'var(--destructive)',
                fontWeight: 500,
                cursor: sendBack.isPending || sentMsg ? 'not-allowed' : 'pointer',
                letterSpacing: '0.05em',
                opacity: sendBack.isPending ? 0.6 : 1,
              }}
            >
              {sendBack.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              {sendBack.isPending ? 'Sending…' : 'Send back to dev'}
            </button>
          )}
          {contextStoryId && (
            <button
              type="button"
              onClick={onOpenInHierarchy}
              style={ghostBtn}
            >
              <ArrowLeft size={12} />
              Open in Hierarchy
            </button>
          )}
          {item.kind === 'gate' && item.row.jobIds[item.check as keyof typeof item.row.jobIds] && (
            <a
              href={`/development/monitor?jobId=${encodeURIComponent(item.row.jobIds[item.check as keyof typeof item.row.jobIds] ?? '')}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...ghostBtn, textDecoration: 'none' }}
            >
              <FileText size={12} />
              View logs
              <ExternalLink size={10} />
            </a>
          )}
          {sentMsg && (
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--success)',
                letterSpacing: '0.06em',
              }}
            >
              ✓ {sentMsg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Per-kind detail panes ───────────────────────────────────────────

function AcDetail({ item }: { item: AcCriterionResult }) {
  return (
    <>
      <SectionLabel>Criterion</SectionLabel>
      <p
        style={{
          fontSize: 13,
          color: 'var(--foreground)',
          lineHeight: 1.55,
          marginTop: 6,
          marginBottom: 16,
          textWrap: 'pretty',
        }}
      >
        {item.text}
      </p>

      {item.poNote && (
        <>
          <SectionLabel>PO note</SectionLabel>
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--text-dim)',
              lineHeight: 1.55,
              marginTop: 6,
              marginBottom: 16,
              padding: '10px 14px',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--warning)',
              background: 'var(--surface)',
              borderRadius: 3,
            }}
          >
            {item.poNote}
          </p>
        </>
      )}

      <MetaGrid
        cells={[
          { label: 'Story', value: item.storyId },
          { label: 'Epic', value: item.epicId.slice(0, 10) },
          { label: 'Browser?', value: item.needsBrowser ? 'yes' : 'no' },
          { label: 'Criterion', value: item.criterionId },
        ]}
      />
    </>
  );
}

function VqaDetail({ item }: { item: VqaTestResult }) {
  return (
    <>
      {item.screenshotUrl && (
        <div
          style={{
            border: `1px solid ${item.passed ? 'var(--success)' : 'var(--destructive)'}`,
            borderRadius: 3,
            overflow: 'hidden',
            marginBottom: 14,
            background: 'var(--surface)',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.screenshotUrl}
            alt={item.testId}
            style={{ width: '100%', display: 'block' }}
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
          />
        </div>
      )}

      {item.expected && (
        <>
          <SectionLabel>Expected</SectionLabel>
          <p
            style={{
              fontSize: 13,
              color: 'var(--foreground)',
              lineHeight: 1.55,
              marginTop: 6,
              marginBottom: 14,
            }}
          >
            {item.expected}
          </p>
        </>
      )}

      {item.observed && (
        <>
          <SectionLabel>Observed</SectionLabel>
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-dim)',
              lineHeight: 1.55,
              marginTop: 6,
              marginBottom: 14,
            }}
          >
            {item.observed}
          </p>
        </>
      )}

      <MetaGrid
        cells={[
          { label: 'Test', value: item.testId },
          { label: 'Story', value: item.storyId },
          { label: 'Epic', value: item.epicId.slice(0, 10) },
          { label: 'Verdict', value: item.passed ? 'PASS' : 'FAIL' },
        ]}
      />
    </>
  );
}

function GateDetail({
  row,
  check,
  cellStatus,
}: {
  row: GateWaveRow;
  check: string;
  cellStatus: string;
}) {
  return (
    <>
      <SectionLabel>Wave check</SectionLabel>
      <p
        style={{
          fontSize: 13,
          color: 'var(--foreground)',
          lineHeight: 1.55,
          marginTop: 6,
          marginBottom: 16,
        }}
      >
        <strong>{row.epicLabel} · {row.waveLabel}</strong> — <code>{check}</code> is{' '}
        <code style={{ color: cellStatus === 'fail' ? 'var(--destructive)' : 'var(--text-dim)' }}>
          {cellStatus}
        </code>
        .
      </p>

      <MetaGrid
        cells={[
          { label: 'Epic', value: row.epicLabel },
          { label: 'Wave', value: String(row.waveIndex) },
          { label: 'Check', value: check },
          { label: 'Status', value: cellStatus },
        ]}
      />

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-faint)',
          marginTop: 14,
          letterSpacing: '0.04em',
        }}
      >
        Open the associated build-check job in the monitor for the full log
        output.
      </div>
    </>
  );
}

// ── Shared subcomponents ────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.24em',
      }}
    >
      {children}
    </div>
  );
}

function MetaGrid({
  cells,
}: {
  cells: Array<{ label: string; value: string }>;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
        marginBottom: 8,
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            padding: '8px 12px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 4,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              color: 'var(--text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 3,
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--foreground)',
              fontWeight: 500,
              wordBreak: 'break-all',
            }}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  padding: '8px 14px',
  borderRadius: 3,
  background: 'var(--surface)',
  border: '1px solid var(--border-2)',
  color: 'var(--text-dim)',
  cursor: 'pointer',
  letterSpacing: '0.05em',
};

// ── Discriminated-union helpers ────────────────────────────────────

function kindLabel(item: FailureDrawerItem): string {
  switch (item.kind) {
    case 'ac':
      return 'Acceptance Criterion';
    case 'vqa':
      return 'Visual QA';
    case 'gate':
      return 'Automated Gate';
  }
}

function titleOf(item: FailureDrawerItem): string {
  switch (item.kind) {
    case 'ac':
      return item.item.text;
    case 'vqa':
      return item.item.expected ?? item.item.testId;
    case 'gate':
      return `${item.row.epicLabel} · ${item.row.waveLabel} · ${item.check}`;
  }
}

function subtitleOf(item: FailureDrawerItem): string {
  switch (item.kind) {
    case 'ac':
      return `${item.item.criterionId} · story ${item.item.storyId}`;
    case 'vqa':
      return `${item.item.testId} · story ${item.item.storyId}`;
    case 'gate':
      return `check “${item.check}” is ${item.cellStatus}`;
  }
}

function storyIdOf(item: FailureDrawerItem): string | null {
  switch (item.kind) {
    case 'ac':
      return item.item.storyId;
    case 'vqa':
      return item.item.storyId;
    case 'gate':
      return null; // gate failures aren't story-scoped; wave-level retry is ops-driven
  }
}

function epicIdOf(item: FailureDrawerItem): string | null {
  switch (item.kind) {
    case 'ac':
      return item.item.epicId;
    case 'vqa':
      return item.item.epicId;
    case 'gate':
      return item.row.epicId;
  }
}

function buildDefaultNote(item: FailureDrawerItem): string {
  switch (item.kind) {
    case 'ac':
      return `AC failed: ${item.item.criterionId} — ${item.item.text}`;
    case 'vqa':
      return `Visual QA failed: ${item.item.testId}${item.item.expected ? ` (expected: ${item.item.expected})` : ''}`;
    case 'gate':
      return `Gate check "${item.check}" is ${item.cellStatus} on ${item.row.epicLabel} ${item.row.waveLabel}. Please investigate and fix.`;
  }
}
