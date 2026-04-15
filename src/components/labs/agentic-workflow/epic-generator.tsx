'use client';
import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { useGenerateEpic, useCreateEpicFromXml } from '@/hooks/use-epic-workflow';
import { StoryLiveOutput } from './story-live-output';

interface EpicGeneratorProps {
  workingDir: string;
  devModel: string;
  devEffort: string;
  reviewerModel: string;
  reviewerEffort: string;
  yoloMode: boolean;
  onEpicCreated: (epicId: string) => void;
}

interface ParsedStory {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  wave: number;
}

interface ParsedEpic {
  title: string;
  description: string;
  testingProfile: { hasBrowserTests: string; viewport: string; interactionModel: string };
  criteria: { text: string; needsBrowser: boolean }[];
  stories: ParsedStory[];
}

function parseEpicFromXml(xml: string): ParsedEpic {
  const title = xml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || '';
  const description = xml.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || '';

  const tpBlock = xml.match(/<testing_profile>([\s\S]*?)<\/testing_profile>/)?.[1] || '';
  const hasBrowserTests =
    tpBlock.match(/<has_browser_tests>([\s\S]*?)<\/has_browser_tests>/)?.[1]?.trim() || 'false';
  const viewport = tpBlock.match(/<viewport>([\s\S]*?)<\/viewport>/)?.[1]?.trim() || '1280x720';
  const interactionModel =
    tpBlock.match(/<interaction_model>([\s\S]*?)<\/interaction_model>/)?.[1]?.trim() || 'mouse';

  const criteriaMatches = [
    ...xml.matchAll(/<criterion(?:\s+needs_browser="(true|false)")?>([\s\S]*?)<\/criterion>/g),
  ];
  const criteria = criteriaMatches.map((m) => ({
    text: m[2].trim(),
    needsBrowser: m[1] === 'true',
  }));

  const storyMatches = [...xml.matchAll(/<story\s+id="(S\d+)">([\s\S]*?)<\/story>/g)];
  const stories = storyMatches.map((m) => {
    const id = m[1];
    const content = m[2];
    const storyTitle = content.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || id;
    const deps = content.match(/<depends_on>([\s\S]*?)<\/depends_on>/)?.[1]?.trim() || '';
    const desc = content.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || '';
    const depIds = deps
      ? deps
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean)
      : [];
    return { id, title: storyTitle, description: desc, dependsOn: depIds, wave: 0 };
  });

  // Compute waves
  const waveCache = new Map<string, number>();
  function computeWave(id: string, visited = new Set<string>()): number {
    if (waveCache.has(id)) return waveCache.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);
    const story = stories.find((s) => s.id === id);
    if (!story || story.dependsOn.length === 0) {
      waveCache.set(id, 0);
      return 0;
    }
    const depWaves = story.dependsOn.map((d) => computeWave(d, visited));
    const wave = Math.max(...depWaves) + 1;
    waveCache.set(id, wave);
    return wave;
  }
  const storiesWithWaves = stories.map((s) => ({ ...s, wave: computeWave(s.id) }));

  return {
    title,
    description,
    testingProfile: { hasBrowserTests, viewport, interactionModel },
    criteria,
    stories: storiesWithWaves,
  };
}

function epicToXml(epic: ParsedEpic): string {
  const criteriaXml = epic.criteria
    .map((c) => `    <criterion needs_browser="${c.needsBrowser}">${c.text}</criterion>`)
    .join('\n');

  const storiesXml = epic.stories
    .map(
      (s) => `    <story id="${s.id}">
      <title>${s.title}</title>
      <depends_on>${s.dependsOn.join(',')}</depends_on>
      <description>${s.description}</description>
    </story>`,
    )
    .join('\n');

  return `<epic>
  <title>${epic.title}</title>
  <description>${epic.description}</description>
  <testing_profile>
    <has_browser_tests>${epic.testingProfile.hasBrowserTests}</has_browser_tests>
    <viewport>${epic.testingProfile.viewport}</viewport>
    <interaction_model>${epic.testingProfile.interactionModel}</interaction_model>
  </testing_profile>
  <acceptance_criteria>
${criteriaXml}
  </acceptance_criteria>
  <stories>
${storiesXml}
  </stories>
</epic>`;
}

export function EpicGenerator({
  workingDir,
  devModel,
  devEffort,
  reviewerModel,
  reviewerEffort,
  yoloMode,
  onEpicCreated,
}: EpicGeneratorProps) {
  const [idea, setIdea] = useState('');
  const [pmJobId, setPmJobId] = useState<string | null>(null);
  const [epicXml, setEpicXml] = useState<string | null>(null);
  const [parsedEpic, setParsedEpic] = useState<ParsedEpic | null>(null);
  const [editingStory, setEditingStory] = useState<string | null>(null);

  const generateEpic = useGenerateEpic();
  const createFromXml = useCreateEpicFromXml();
  const { data: pmJob } = useAgentJob(pmJobId);
  useAgentEvents(pmJobId, pmJob?.status);

  // When PM job completes, extract and parse the XML
  const generatedXml = pmJob?.variables?.EPIC_XML;
  if (generatedXml && !epicXml) {
    const fullXml = '<epic>' + generatedXml;
    setEpicXml(fullXml);
    setParsedEpic(parseEpicFromXml(fullXml));
  }

  // Helper to update parsed epic and regenerate XML
  function updateEpic(updater: (e: ParsedEpic) => ParsedEpic) {
    if (!parsedEpic) return;
    const updated = updater(parsedEpic);
    setParsedEpic(updated);
    setEpicXml(epicToXml(updated));
  }

  // Group stories by wave
  const waves = useMemo(() => {
    if (!parsedEpic) return [];
    const map = new Map<number, ParsedStory[]>();
    for (const s of parsedEpic.stories) {
      if (!map.has(s.wave)) map.set(s.wave, []);
      map.get(s.wave)!.push(s);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [parsedEpic]);

  function handleGenerate() {
    if (!idea.trim() || !workingDir.trim()) return;
    setEpicXml(null);
    generateEpic.mutate(
      { idea: idea.trim(), workingDir: workingDir.trim() },
      {
        onSuccess: (data) => {
          setPmJobId(data.jobId);
          console.log('[PM] Generate epic job:', data.jobId);
        },
        onError: (err) => {
          console.error('[PM] Failed to create job:', err);
        },
      },
    );
  }

  function handleStartDevelopment() {
    if (!epicXml) return;
    createFromXml.mutate(
      { xml: epicXml, workingDir, yoloMode, devModel, devEffort, reviewerModel, reviewerEffort },
      {
        onSuccess: (data) => {
          console.log('[PM] Epic created:', data.epicId, 'stories:', data.storiesCount);
          onEpicCreated(data.epicId);
        },
      },
    );
  }

  const isGenerating = pmJob?.status === 'PENDING' || pmJob?.status === 'RUNNING';
  const pmFailed =
    pmJob?.status === 'FAILED' || (pmJob?.status === 'COMPLETED' && !generatedXml && pmJobId);
  const pmError =
    pmJob?.errorMessage ||
    (pmFailed && !generatedXml
      ? 'PM agent produced no epic. Check daemon logs or auth status.'
      : null);

  return (
    <div className="space-y-4">
      {/* Idea input */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Product Manager Agent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder='Describe your product idea... e.g. "I want a basic game like Guess the Number with difficulty levels, score tracking, and a polished UI"'
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleGenerate}
              disabled={
                !idea.trim() || !workingDir.trim() || isGenerating || generateEpic.isPending
              }
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? 'PM is thinking...' : 'Generate Epic'}
            </button>
            {!workingDir.trim() && (
              <span className="text-xs text-red-500">Set working directory first</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* PM agent live output while generating */}
      {pmJobId && isGenerating && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              PM Agent Working...
              <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StoryLiveOutput jobId={pmJobId} />
          </CardContent>
        </Card>
      )}

      {/* PM Error */}
      {pmError && !isGenerating && (
        <Card className="border-red-900">
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-red-500 font-medium text-sm">PM Agent Failed</span>
            </div>
            <p className="text-xs text-red-400">{pmError}</p>
            {pmError.includes('authentication') && (
              <p className="text-[10px] text-muted-foreground">
                The Claude Code OAuth token on EC2 has expired. Re-transfer credentials from your
                Mac or re-run claude auth login on the instance.
              </p>
            )}
            <button
              onClick={handleGenerate}
              className="rounded-md bg-red-900 px-3 py-1 text-xs text-red-100 hover:bg-red-800"
            >
              Retry
            </button>
          </CardContent>
        </Card>
      )}

      {/* API mutation error */}
      {generateEpic.error && (
        <Card className="border-red-900">
          <CardContent className="pt-4">
            <p className="text-xs text-red-400">
              API Error: {(generateEpic.error as Error).message}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Structured epic editor */}
      {parsedEpic && parsedEpic.stories.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0 mr-4">
                <input
                  value={parsedEpic.title}
                  onChange={(e) => updateEpic((ep) => ({ ...ep, title: e.target.value }))}
                  className="w-full bg-transparent text-sm font-semibold border-b border-transparent hover:border-input focus:border-ring focus:outline-none py-0.5"
                />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {parsedEpic.stories.length} stories · {waves.length} waves
                </span>
                <button
                  onClick={handleStartDevelopment}
                  disabled={createFromXml.isPending}
                  className="rounded-md bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {createFromXml.isPending ? 'Creating...' : 'Start Development'}
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Description */}
            <textarea
              value={parsedEpic.description}
              onChange={(e) => updateEpic((ep) => ({ ...ep, description: e.target.value }))}
              className="w-full bg-transparent text-xs text-muted-foreground border border-transparent hover:border-input focus:border-ring focus:outline-none rounded px-2 py-1.5 resize-none"
              rows={2}
            />

            {/* Testing profile */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Testing:
              </span>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={parsedEpic.testingProfile.hasBrowserTests === 'true'}
                  onChange={(e) =>
                    updateEpic((ep) => ({
                      ...ep,
                      testingProfile: {
                        ...ep.testingProfile,
                        hasBrowserTests: e.target.checked ? 'true' : 'false',
                      },
                    }))
                  }
                  className="rounded"
                />
                Browser tests
              </label>
              <input
                value={parsedEpic.testingProfile.viewport}
                onChange={(e) =>
                  updateEpic((ep) => ({
                    ...ep,
                    testingProfile: { ...ep.testingProfile, viewport: e.target.value },
                  }))
                }
                className="w-24 bg-transparent text-xs font-mono border border-input rounded px-1.5 py-0.5 focus:border-ring focus:outline-none"
                placeholder="1280x720"
              />
              <select
                value={parsedEpic.testingProfile.interactionModel}
                onChange={(e) =>
                  updateEpic((ep) => ({
                    ...ep,
                    testingProfile: { ...ep.testingProfile, interactionModel: e.target.value },
                  }))
                }
                className="bg-transparent text-xs border border-input rounded px-1.5 py-0.5"
              >
                <option value="mouse">mouse</option>
                <option value="keyboard">keyboard</option>
                <option value="touch">touch</option>
                <option value="keyboard,mouse">keyboard+mouse</option>
              </select>
            </div>

            {/* Acceptance criteria */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Acceptance Criteria
                </span>
                <button
                  onClick={() =>
                    updateEpic((ep) => ({
                      ...ep,
                      criteria: [...ep.criteria, { text: '', needsBrowser: false }],
                    }))
                  }
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  + Add
                </button>
              </div>
              {parsedEpic.criteria.map((c, i) => (
                <div key={i} className="flex items-start gap-2">
                  <button
                    onClick={() =>
                      updateEpic((ep) => ({
                        ...ep,
                        criteria: ep.criteria.map((cr, j) =>
                          j === i ? { ...cr, needsBrowser: !cr.needsBrowser } : cr,
                        ),
                      }))
                    }
                    className={`shrink-0 mt-1 rounded px-1.5 py-0.5 text-[9px] ${
                      c.needsBrowser
                        ? 'bg-purple-900/50 text-purple-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                    title="Toggle needs_browser"
                  >
                    {c.needsBrowser ? 'browser' : 'code'}
                  </button>
                  <input
                    value={c.text}
                    onChange={(e) =>
                      updateEpic((ep) => ({
                        ...ep,
                        criteria: ep.criteria.map((cr, j) =>
                          j === i ? { ...cr, text: e.target.value } : cr,
                        ),
                      }))
                    }
                    className="flex-1 bg-transparent text-xs border-b border-transparent hover:border-input focus:border-ring focus:outline-none py-0.5"
                    placeholder="Criterion..."
                  />
                  <button
                    onClick={() =>
                      updateEpic((ep) => ({
                        ...ep,
                        criteria: ep.criteria.filter((_, j) => j !== i),
                      }))
                    }
                    className="text-[10px] text-muted-foreground hover:text-red-400 shrink-0 mt-0.5"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>

            {/* Stories — grouped by wave */}
            <div className="space-y-3">
              {waves.map(([waveNum, waveStories]) => (
                <div key={waveNum}>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Wave {waveNum} {waveStories.length > 1 && `(${waveStories.length} parallel)`}
                  </div>
                  <div className="space-y-1.5">
                    {waveStories.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-md border border-input bg-muted/10 px-3 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                            {s.id}
                          </span>
                          <input
                            value={s.title}
                            onChange={(e) =>
                              updateEpic((ep) => ({
                                ...ep,
                                stories: ep.stories.map((st) =>
                                  st.id === s.id ? { ...st, title: e.target.value } : st,
                                ),
                              }))
                            }
                            className="flex-1 bg-transparent font-medium border-b border-transparent hover:border-input focus:border-ring focus:outline-none py-0.5"
                          />
                          {s.dependsOn.length > 0 && (
                            <span className="text-[9px] text-muted-foreground shrink-0">
                              deps: {s.dependsOn.join(',')}
                            </span>
                          )}
                          <button
                            onClick={() => setEditingStory(editingStory === s.id ? null : s.id)}
                            className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
                          >
                            {editingStory === s.id ? 'close' : 'edit'}
                          </button>
                          <button
                            onClick={() =>
                              updateEpic((ep) => ({
                                ...ep,
                                stories: ep.stories.filter((st) => st.id !== s.id),
                              }))
                            }
                            className="text-[10px] text-muted-foreground hover:text-red-400 shrink-0"
                          >
                            x
                          </button>
                        </div>
                        {editingStory === s.id && (
                          <div className="mt-2 space-y-2">
                            <div>
                              <label className="text-[10px] text-muted-foreground">
                                Dependencies (comma-separated story IDs)
                              </label>
                              <input
                                value={s.dependsOn.join(',')}
                                onChange={(e) =>
                                  updateEpic((ep) => ({
                                    ...ep,
                                    stories: ep.stories.map((st) =>
                                      st.id === s.id
                                        ? {
                                            ...st,
                                            dependsOn: e.target.value
                                              .split(',')
                                              .map((d) => d.trim())
                                              .filter(Boolean),
                                          }
                                        : st,
                                    ),
                                  }))
                                }
                                className="w-full bg-background text-xs border border-input rounded px-2 py-1 mt-0.5 focus:border-ring focus:outline-none font-mono"
                                placeholder="S1,S2"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-muted-foreground">
                                Description & Acceptance Criteria
                              </label>
                              <textarea
                                value={s.description}
                                onChange={(e) =>
                                  updateEpic((ep) => ({
                                    ...ep,
                                    stories: ep.stories.map((st) =>
                                      st.id === s.id ? { ...st, description: e.target.value } : st,
                                    ),
                                  }))
                                }
                                className="w-full bg-background text-xs border border-input rounded px-2 py-1.5 mt-0.5 resize-none focus:border-ring focus:outline-none"
                                rows={6}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {waveNum < waves[waves.length - 1][0] && (
                    <div className="ml-4 mt-1 text-muted-foreground/30">↓</div>
                  )}
                </div>
              ))}

              {/* Add story button */}
              <button
                onClick={() => {
                  const nextNum = parsedEpic.stories.length + 1;
                  updateEpic((ep) => ({
                    ...ep,
                    stories: [
                      ...ep.stories,
                      {
                        id: `S${nextNum}`,
                        title: `Story ${nextNum}`,
                        description: '',
                        dependsOn: [],
                        wave: 0,
                      },
                    ],
                  }));
                }}
                className="w-full rounded-md border border-dashed border-input py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              >
                + Add Story
              </button>
            </div>

            {/* Raw XML toggle */}
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                XML Source
              </summary>
              <pre className="mt-1 whitespace-pre-wrap text-[10px] text-muted-foreground bg-muted/30 rounded p-3 max-h-48 overflow-auto font-mono">
                {epicXml}
              </pre>
            </details>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
