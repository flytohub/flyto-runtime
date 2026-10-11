# Chat Supervisor multi-window fault visibility — 2026-10-11

## Problem and change

The macOS Accessibility observer used only the first ChatGPT AX window.
With two separate ChatGPT windows, an error in the second could be invisible
to `supervisor status` even when its window was accessible. The observer now
samples up to eight AX windows, keeps independent unchanged timers and
fingerprints, reports a bounded `windows` array, and projects the
highest-priority fault to the existing top-level fields. More than eight
accessible windows explicitly reports partial coverage. Background tabs and
the progress of the underlying model remain unobservable.

## Evidence and limits

- Base SHA: `cde6bf75c191ba9c2514486620767edf9bf5b693`.
- Swift self-test, including a fault in the second window: PASS.
- `tsx --test src/flyto2/chat-supervisor.test.ts`: 8/8 PASS.
- `npm run typecheck`, `npm run build`, `npm run lint`: PASS.
- `flyto-index verify . --full-scan --strict --json`: PASS.
- Integrated the independent stale-observation capability fix on a clean
  worktree at the same base SHA. The combined regression suite passes 9/9,
  with Swift native self-test, typecheck, build, architecture lint, and
  strict Indexer 20/20 passing. An observation older than 60 seconds can no
  longer advertise active Accessibility or error detection.
- This is source-level verification. The installed ad-hoc signed macOS app
  was **not** replaced or restarted: changing its signature may invalidate
  existing Accessibility consent. Real two-window GUI acceptance is pending.
- No Retry, Continue, stop, conversation creation, deletion, or autonomous
  handoff is enabled. A UI fault is not proof of a failed underlying task.
- Durable Runtime recovery task IDs: `task_4ce67eddab1048edb72a94e41c7cad8b`
  (multiwindow) and `task_dab5d1bc66714fa6ba8926df277547de`
  (stale observation). Source integration does not imply the macOS helper
  has been upgraded.

## Next step

In a controlled session, install the updated signed observer, re-authorize
Accessibility if macOS requires it, and verify that two separate ChatGPT
windows show two `observation.windows` entries and a second-window error
appears at the top level. Check original Runtime task evidence before any
manual retry; do not resend a side-effecting command blindly.
