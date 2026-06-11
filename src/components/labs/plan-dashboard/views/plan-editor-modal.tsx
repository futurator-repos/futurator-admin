'use client';

/**
 * Plan Editor — structured (non-JSON) editing of a concept-stage plan.
 *
 * The operator asked for this after the JSON modal proved UX-hostile for
 * real edits: descriptions are multi-paragraph prose, ACs are sentences,
 * and hand-balancing braces to flip one `needsBrowser` flag is silly.
 *
 * Model: the editor works on a DRAFT mirror of the PM-output JSON shape
 * (plan → epics → stories → criteria) with stable client-side keys. On
 * save it serializes back to the PM-output schema (fresh local ids E1…,
 * S1… globally sequential, dependsOn remapped) and submits through the
 * SAME import funnel the PM agent's own output passes (schema, references,
 * touch-point hygiene, visual coverage) — validation errors render inline.
 *
 * Dependency editing is constrained to what the schema allows: a story may
 * depend only on EARLIER stories in the same epic; an epic only on earlier
 * epics. Both render as toggle chips.
 */

import { useMemo, useState } from 'react';

// ── Draft model ──────────────────────────────────────────────────────

interface DraftCriterion {
  key: string;
  text: string;
  needsBrowser: boolean;
}

interface DraftStory {
  key: string;
  title: string;
  description: string;
  /** newline-separated in the textarea; split + trimmed on save. */
  touchPointsText: string;
  /** keys of earlier sibling stories. */
  dependsOn: string[];
  criteria: DraftCriterion[];
}

interface DraftEpic {
  key: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  /** keys of earlier epics. */
  dependsOn: string[];
  stories: DraftStory[];
}

export interface PlanDraft {
  name: string;
  description: string;
  epics: DraftEpic[];
}

let keyCounter = 0;
const nextKey = () => `k${++keyCounter}`;

/** Build a draft from an exported plan-output JSON value. */
export function planOutputToDraft(output: {
  plan: {
    name: string;
    description: string;
    epics: Array<{
      id: string;
      title: string;
      goal: string;
      acceptanceCriteria?: string;
      dependsOn?: string[];
      stories: Array<{
        id: string;
        title: string;
        description: string;
        dependsOn?: string[];
        touchPoints?: string[];
        criteria: Array<{ id: string; text: string; needsBrowser?: boolean }>;
      }>;
    }>;
  };
}): PlanDraft {
  const epicKeyByLocal = new Map<string, string>();
  const epics: DraftEpic[] = output.plan.epics.map((e) => {
    const ekey = nextKey();
    epicKeyByLocal.set(e.id, ekey);
    const storyKeyByLocal = new Map<string, string>();
    const stories: DraftStory[] = e.stories.map((s) => {
      const skey = nextKey();
      storyKeyByLocal.set(s.id, skey);
      return {
        key: skey,
        title: s.title,
        description: s.description,
        touchPointsText: (s.touchPoints ?? []).join('\n'),
        dependsOn: (s.dependsOn ?? [])
          .map((id) => storyKeyByLocal.get(id))
          .filter((k): k is string => !!k),
        criteria: s.criteria.map((c) => ({
          key: nextKey(),
          text: c.text,
          needsBrowser: !!c.needsBrowser,
        })),
      };
    });
    return {
      key: ekey,
      title: e.title,
      goal: e.goal,
      acceptanceCriteria: e.acceptanceCriteria ?? '',
      dependsOn: (e.dependsOn ?? [])
        .map((id) => epicKeyByLocal.get(id))
        .filter((k): k is string => !!k),
      stories,
    };
  });
  return { name: output.plan.name, description: output.plan.description, epics };
}

/** Serialize a draft back to the PM-output JSON shape (fresh local ids). */
export function draftToPlanOutput(draft: PlanDraft): unknown {
  const epicLocalByKey = new Map<string, string>();
  draft.epics.forEach((e, i) => epicLocalByKey.set(e.key, `E${i + 1}`));
  let storyN = 0;
  return {
    plan: {
      name: draft.name,
      description: draft.description,
      epics: draft.epics.map((e, ei) => {
        const storyLocalByKey = new Map<string, string>();
        for (const s of e.stories) {
          storyN += 1;
          storyLocalByKey.set(s.key, `S${storyN}`);
        }
        return {
          id: `E${ei + 1}`,
          title: e.title,
          goal: e.goal,
          acceptanceCriteria: e.acceptanceCriteria,
          dependsOn: e.dependsOn
            .map((k) => epicLocalByKey.get(k))
            .filter((id): id is string => !!id),
          stories: e.stories.map((s) => {
            const local = storyLocalByKey.get(s.key)!;
            return {
              id: local,
              title: s.title,
              description: s.description,
              dependsOn: s.dependsOn
                .map((k) => storyLocalByKey.get(k))
                .filter((id): id is string => !!id),
              touchPoints: s.touchPointsText
                .split('\n')
                .map((t) => t.trim())
                .filter(Boolean),
              criteria: s.criteria.map((c, ci) => ({
                id: `AC-${local}-${ci + 1}`,
                text: c.text,
                needsBrowser: c.needsBrowser,
              })),
            };
          }),
        };
      }),
    },
  };
}

// ── Component ────────────────────────────────────────────────────────

export function PlanEditorModal({
  initial,
  pending,
  onCancel,
  onSubmit,
}: {
  initial: PlanDraft;
  pending: boolean;
  onCancel: () => void;
  /** Receives the serialized plan-output JSON string; throws on server rejection. */
  onSubmit: (planJson: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PlanDraft>(initial);
  const [error, setError] = useState<string | null>(null);

  const totalStories = useMemo(
    () => draft.epics.reduce((a, e) => a + e.stories.length, 0),
    [draft],
  );

  function patchEpic(ekey: string, patch: Partial<DraftEpic>) {
    setDraft((d) => ({
      ...d,
      epics: d.epics.map((e) => (e.key === ekey ? { ...e, ...patch } : e)),
    }));
  }

  function patchStory(ekey: string, skey: string, patch: Partial<DraftStory>) {
    setDraft((d) => ({
      ...d,
      epics: d.epics.map((e) =>
        e.key === ekey
          ? { ...e, stories: e.stories.map((s) => (s.key === skey ? { ...s, ...patch } : s)) }
          : e,
      ),
    }));
  }

  async function submit() {
    setError(null);
    try {
      await onSubmit(JSON.stringify(draftToPlanOutput(draft)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <div
        onClick={onCancel}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 80 }}
      />
      <div
        role="dialog"
        aria-label="Edit plan"
        style={{
          position: 'fixed',
          top: '4vh',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(980px, 96vw)',
          height: '92vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elev, var(--background))',
          border: '1px solid var(--border)',
          borderRadius: 8,
          zIndex: 81,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <Label>Edit plan</Label>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              {draft.epics.length} epics · {totalStories} stories — applying replaces the current
              tree; waves recompute from dependencies + touch points
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn label="Cancel" onClick={onCancel} disabled={pending} />
            <Btn
              solid
              label={pending ? 'Applying…' : 'Validate & apply'}
              onClick={submit}
              disabled={pending}
            />
          </div>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <Field label="Plan description">
            <textarea
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              rows={3}
              style={textareaStyle}
            />
          </Field>

          {draft.epics.map((epic, ei) => (
            <section
              key={epic.key}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                background: 'color-mix(in srgb, var(--foreground) 1.5%, transparent)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--accent-blue)',
                  }}
                >
                  E{ei + 1}
                </span>
                <input
                  value={epic.title}
                  onChange={(e) => patchEpic(epic.key, { title: e.target.value })}
                  placeholder="Epic title"
                  style={{ ...inputStyle, flex: 1, fontSize: 14, fontWeight: 500 }}
                />
                <Btn
                  label="✕ epic"
                  danger
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      epics: d.epics
                        .filter((e) => e.key !== epic.key)
                        .map((e) => ({
                          ...e,
                          dependsOn: e.dependsOn.filter((k) => k !== epic.key),
                        })),
                    }))
                  }
                />
              </div>
              <Field label="Goal">
                <textarea
                  value={epic.goal}
                  onChange={(e) => patchEpic(epic.key, { goal: e.target.value })}
                  rows={2}
                  style={textareaStyle}
                />
              </Field>
              {ei > 0 && (
                <ChipToggles
                  label="Depends on epics"
                  options={draft.epics.slice(0, ei).map((e, i) => ({
                    key: e.key,
                    label: `E${i + 1} ${e.title.slice(0, 28)}`,
                  }))}
                  selected={epic.dependsOn}
                  onChange={(dependsOn) => patchEpic(epic.key, { dependsOn })}
                />
              )}

              {epic.stories.map((story, si) => (
                <div
                  key={story.key}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    marginLeft: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--text-faint)',
                      }}
                    >
                      story {si + 1}
                    </span>
                    <input
                      value={story.title}
                      onChange={(e) => patchStory(epic.key, story.key, { title: e.target.value })}
                      placeholder="Story title (action-oriented)"
                      style={{ ...inputStyle, flex: 1, fontWeight: 500 }}
                    />
                    <Btn
                      label="✕"
                      danger
                      onClick={() =>
                        patchEpic(epic.key, {
                          stories: epic.stories
                            .filter((s) => s.key !== story.key)
                            .map((s) => ({
                              ...s,
                              dependsOn: s.dependsOn.filter((k) => k !== story.key),
                            })),
                        })
                      }
                    />
                  </div>
                  <Field label="Description">
                    <textarea
                      value={story.description}
                      onChange={(e) =>
                        patchStory(epic.key, story.key, { description: e.target.value })
                      }
                      rows={3}
                      style={textareaStyle}
                    />
                  </Field>
                  <Field label="Touch points (one file path per line; <EPIC_WIDE> for cross-cutting)">
                    <textarea
                      value={story.touchPointsText}
                      onChange={(e) =>
                        patchStory(epic.key, story.key, { touchPointsText: e.target.value })
                      }
                      rows={Math.max(2, story.touchPointsText.split('\n').length)}
                      style={{ ...textareaStyle, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
                      spellCheck={false}
                    />
                  </Field>
                  {si > 0 && (
                    <ChipToggles
                      label="Depends on stories"
                      options={epic.stories.slice(0, si).map((s, i) => ({
                        key: s.key,
                        label: `${i + 1} ${s.title.slice(0, 32)}`,
                      }))}
                      selected={story.dependsOn}
                      onChange={(dependsOn) => patchStory(epic.key, story.key, { dependsOn })}
                    />
                  )}
                  <Field label="Acceptance criteria">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {story.criteria.map((c) => (
                        <div
                          key={c.key}
                          style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}
                        >
                          <textarea
                            value={c.text}
                            onChange={(e) =>
                              patchStory(epic.key, story.key, {
                                criteria: story.criteria.map((x) =>
                                  x.key === c.key ? { ...x, text: e.target.value } : x,
                                ),
                              })
                            }
                            rows={Math.max(1, Math.ceil(c.text.length / 110))}
                            style={{ ...textareaStyle, flex: 1, fontSize: 12 }}
                          />
                          <label
                            title="Verified by the idle-frame screenshot judge"
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: 10,
                              fontFamily: 'var(--font-mono)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.1em',
                              color: c.needsBrowser ? 'var(--accent-purple)' : 'var(--text-faint)',
                              cursor: 'pointer',
                              paddingTop: 6,
                              flexShrink: 0,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={c.needsBrowser}
                              onChange={(e) =>
                                patchStory(epic.key, story.key, {
                                  criteria: story.criteria.map((x) =>
                                    x.key === c.key ? { ...x, needsBrowser: e.target.checked } : x,
                                  ),
                                })
                              }
                            />
                            browser
                          </label>
                          <Btn
                            label="✕"
                            danger
                            onClick={() =>
                              patchStory(epic.key, story.key, {
                                criteria: story.criteria.filter((x) => x.key !== c.key),
                              })
                            }
                          />
                        </div>
                      ))}
                      <Btn
                        label="+ AC"
                        onClick={() =>
                          patchStory(epic.key, story.key, {
                            criteria: [
                              ...story.criteria,
                              { key: nextKey(), text: '', needsBrowser: false },
                            ],
                          })
                        }
                      />
                    </div>
                  </Field>
                </div>
              ))}
              <Btn
                label="+ story"
                onClick={() =>
                  patchEpic(epic.key, {
                    stories: [
                      ...epic.stories,
                      {
                        key: nextKey(),
                        title: '',
                        description: '',
                        touchPointsText: '',
                        dependsOn: [],
                        criteria: [{ key: nextKey(), text: '', needsBrowser: false }],
                      },
                    ],
                  })
                }
              />
            </section>
          ))}
          <Btn
            label="+ epic"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                epics: [
                  ...d.epics,
                  {
                    key: nextKey(),
                    title: '',
                    goal: '',
                    acceptanceCriteria: '',
                    dependsOn: [],
                    stories: [],
                  },
                ],
              }))
            }
          />
        </div>

        {error && (
          <div
            style={{
              flexShrink: 0,
              margin: '0 20px 16px',
              border: '1px solid var(--destructive)',
              background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
              color: 'var(--destructive)',
              borderRadius: 6,
              padding: '10px 12px',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 140,
              overflowY: 'auto',
            }}
          >
            {error}
          </div>
        )}
      </div>
    </>
  );
}

// ── Small primitives (style-matched to plan-review-view) ─────────────

const inputStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '6px 10px',
  fontSize: 13,
  color: 'var(--foreground)',
  outline: 'none',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  width: '100%',
  lineHeight: 1.55,
  resize: 'vertical',
  fontFamily: 'var(--font-sans)',
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.22em',
      }}
    >
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ChipToggles({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { key: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <Label>{label}</Label>
      {options.map((o) => {
        const on = selected.includes(o.key);
        return (
          <button
            key={o.key}
            type="button"
            onClick={() =>
              onChange(on ? selected.filter((k) => k !== o.key) : [...selected, o.key])
            }
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 12,
              border: `1px solid ${on ? 'var(--accent-blue)' : 'var(--border)'}`,
              background: on
                ? 'color-mix(in srgb, var(--accent-blue) 12%, transparent)'
                : 'transparent',
              color: on ? 'var(--accent-blue)' : 'var(--text-mute)',
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
      {options.length === 0 && (
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>(none available)</span>
      )}
    </div>
  );
}

function Btn({
  label,
  onClick,
  disabled,
  solid,
  danger,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  solid?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 10,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        padding: '5px 12px',
        borderRadius: 2,
        border: `1px solid ${danger ? 'color-mix(in srgb, var(--destructive) 50%, transparent)' : solid ? 'var(--foreground)' : 'var(--border-2, var(--border))'}`,
        background: solid ? 'var(--foreground)' : 'transparent',
        color: danger ? 'var(--destructive)' : solid ? 'var(--background)' : 'var(--text-dim)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        alignSelf: 'flex-start',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}
