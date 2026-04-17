# Futurator-Admin Review Rubric — Project Overlay

Overlay intro.

## R-ARCH-001 — DynamoDB Multi-Table Only

- **Check**: One concern per table.
- **Rationale**: CLAUDE.md forbids single-table design.

## R-SAFE-001 — Never sync admin out/ to public bucket

- **Check**: Reject `aws s3 sync out/ s3://futurator-ai-website`.
- **Rationale**: 2026-04-15 incident.
