# HackPilot Design Guide

HackPilot helps builders make decisions and track progress under a deadline.
The hackathon workspace keeps the plan and evidence visible while Pilot acts
on the same workspace from the sidebar. AgentKit owns the conversation
primitives and the shared shell owns navigation.

## Hackathon workspace

- Keep the event name, deadline, and selected idea visible across Overview,
  Ideas, Plan, and Checklist. Show the event timezone and the builder's local
  time when they differ.
- In Ideas, pair the weighted score with the criteria and rationale behind it.
  Use the **Our pick** label to make the selected idea clear at a glance.
- In Plan, organize work by milestone and due day. Make it easy to see what is
  done, what is overdue, and where a task will land during a drag. Keep build
  status, logs, and the resulting preview and ZIP near the plan.
- In Checklist, keep each requirement beside its status and proof link. The
  readiness check should point builders to the specific work still open.
- Use neutral surfaces and the shared semantic tokens. Reserve the orange
  `signal` tokens for deadline pressure, scores, the selected idea, and other
  workspace emphasis. Pair color with text or icons, and use tabular numerals
  for countdowns and scores.

## Chat and navigation

- Direction name: Quiet conversation library
- Palette family: neutral ink and semantic surfaces; active rows use the
  existing sidebar accent rather than a separate branded color.
- Type treatment: dense sans-serif labels with regular-weight conversation
  titles and restrained section labels.
- Composition: a persistent conversation library beside a generous chat
  canvas. New chat is the primary rail action, followed by Pinned and Recents.
  Account, workspace, settings, and sign-out controls disclose from one footer
  row instead of competing in the rail.
- Shape language: borderless lists, soft selected rows, quiet corners, and
  compact icon controls.
- Anti-references: icon-only navigation as the default state, floating chips,
  duplicated settings links, timestamps competing with thread titles, and
  placeholder destinations that the app does not implement.

## Guardrails

- Preserve the scaffold's semantic tokens and shared component seams.
- Keep domain pages distinct from full-page chat and use the AgentSidebar for
  contextual AI.
- Compare sibling apps before reusing their palette or composition.
- Keep pinning, rename, archive, and routing wired to the shared chat thread
  model; the sidebar is a presentation layer, not a second history store.
