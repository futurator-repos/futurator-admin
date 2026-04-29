Story: {{storyId}} — {{title}}
Acceptance criteria:
{{bulletedList}}

Touch points declared:
{{globs}}

Diff:
{{gitDiffOutput}}

Rubric:
{{fullRubric}}

{{priorFindingsBlock}}
Effort: {{effortKeyword}}

Review per your spec. Emit a structured verdict using EXACTLY this format:

```
---REVIEW_CRITERIA---
AC-1: <verdict> — <one-line reason>
AC-2: <verdict> — <one-line reason>
...
---END_REVIEW_CRITERIA---
```

Verdict MUST be EXACTLY one of these literal strings — case-sensitive, no abbreviations:

  pass         — the AC is satisfied
  fail         — the AC is not satisfied
  needs-human  — the AC is subjective / requires operator judgement

Forbidden values (will cause the daemon to FAIL the verdict):
  needsan, needs-an, needhuman, need-human, unsure, maybe, partial, ?,
  any other variant or abbreviation.

If you are unsure whether an AC passes, emit `needs-human` (with the hyphen).
Do NOT make up a verdict; the operator will resolve it via Talk-to-agent.

Both `---REVIEW_CRITERIA---` and `---END_REVIEW_CRITERIA---` MUST appear on
their own lines (the daemon's parser is line-anchored). One AC per line. No
bullet markers, no JSON, no code fences around the block.
