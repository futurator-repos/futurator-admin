# Global Default Review Rubric

Intro paragraph.

## R-CORR-001 — Story acceptance criteria are satisfied

- **Rule**: AC bullets map to observable behavior.
- **Rationale**: Reviews verify story goal.

## R-CORR-002 — No placeholder logic

- **Rule**: Reject TODO branches on the happy path.
- **Rationale**: Placeholders ship bugs.

## R-SEC-001 — No hardcoded secrets

- **Rule**: Reject AKIA- or sk- literals in the diff.
- **Rationale**: Secrets in history are expensive to rotate.
