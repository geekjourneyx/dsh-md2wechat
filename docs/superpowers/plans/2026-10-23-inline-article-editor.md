# Inline Article Editor Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated domain work and review; execute coupled UI work in this session. Track completion below.

**Goal:** Implement the approved single-page conversation article workspace with a message-card cover/title, inline three-cover selection, direct text editing, and verified draft preparation.

**Architecture:** Keep the existing authenticated creator service, immutable revisions, signed provider preview, and delivery protections. Change the workspace presentation without replacing the DSH conversation. Add version-checked paragraph editing and explicit per-request image progress; never edit provider HTML or remove iframe isolation.

**Tech Stack:** Existing React/TypeScript, Cordis/Typert, md2wechat CLI, Vitest/jsdom, installed DSH acceptance fixture. Reuse host icon assets where possible.

## Approved visual and constraints

Reference: /Users/geekjourney/.codex/generated_images/01a159e6-a3b3-7ba2-9e54-76e6807aaff7/exec-85e9986f-851d-42fb-8316-6c7856a4b2e1.png.
The host left conversation remains native. Right header has status, undo/refresh/expand icons and a text draft action. One narrow reading surface contains a cover card with editable overlay title, inline title/cover choices and body below. No bottom drawer or functional tabs. Cover selection never inserts an image into the body. Real content and selected images replace mock imagery. Empty/error states must be honest.

## Task 1 — Domain operations and progress

Files: src/creator/types.ts, session.ts, service.ts, runtime.ts; tests/creator/image-session.test.ts and service tests.
- [x] Add `edit-text` action carrying exact `before` and `after` text, validated as a bounded nonempty exact replacement through existing immutable revise/rebind/undo path. Reject ambiguous/stale edits, maintain title/cover integrity.
- [x] Image requests expose expected/completed counts and current-batch candidate IDs. Cover expects 3; body/upload expects 1. First cover result remains pending; third becomes ready. Duplicates do not increase counts, failure retains successes, old callbacks remain rejected, clone request arrays when forking/viewing.
- [x] Plan three distinct cover items before current-conversation followup, preserving side-effect-free planning. Do not claim paid generation was tested.
- [x] Regression tests: 0/3, 1/3, 3/3, duplicate, stale and failed batch; uploaded cover completes 1/1; exact body edit undo/preview invalidation and ownership/version rejection.

## Task 2 — Single-page workspace

Files: src/client/CreatorWorkspace.tsx, CreatorWorkspace.css, ArticlePreview.tsx; new small icon/editor components if needed; tests/creator/workspace-ui.test.ts.
- [x] Replace tab-like toolbar and side inspector with single inline article canvas. Preserve truthful loading/error/recovery/unknown-delivery states.
- [x] Message card uses verified selected image with actual title overlay; empty card invites choosing a cover. Inline title edit, suggestions and cover chooser are mutually exclusive. Three thumbnails plus real progress, selected cover retention, prior choices available separately.
- [x] Keep click targets >= 36px, labels/tooltips/keyboard names, visible focus. Small sidebar wraps controls without horizontal overflow. Expand toggles only article view.
- [x] Keep iframe sandbox and signed preview checks. Add paragraph editing in-place in article canvas (controlled source paragraphs, not provider DOM); save exact edits and rebuild actual preview; cancel retains text. Do not add a second file editor application.
- [x] Keep theme dropdown, comparison, body-image placement, source recovery, export and safe delivery accessible inline with secondary details for uncommon actions.
- [x] Draft entry runs article check then displays actionable checklist and existing final-review/confirmation flow in same page. No automatic upload/draft side effects on entry.
- [x] Regression tests for title, cover, text edit save/cancel/failure, no tab navigation, current preview review gate, stale responses, unreadable HTML, partial image results, switching articles and narrow layout semantics.

## Task 3 — Verification and installation

Files: scripts/creator-host-acceptance/*, docs/research/2026-10-23-inline-editor-acceptance.md; README.md if usage changed.
- [x] Run focused tests during each task, then full `pnpm run test`, `pnpm run lint`, `pnpm run build` (includes type checking), package archive boundary check. Use Node24 and `pnpm_config_verify_deps_before_run=false` to avoid unrelated dependency reinstall. Tests binding localhost need host permission.
- [x] Run installed-host acceptance with harmless fixtures: real CLI preview/check, simulated upload/draft, no live publication. Extend only meaningful assertions for new actions/progress.
- [x] Open installed DSH browser: verified narrow sidebar, title/paragraph save, read-only history, source conversation navigation, global scrolling, and real production refresh. Cover batch/selection, cancellation/failure, theme and draft gates are covered by automated fixture tests; no paid generation/live draft was run.
- [x] Compare screenshot with approved design; fix material hierarchy/spacing/overflow issues and rerun affected checks. Save evidence and exact limitations, no claims of real paid generation or live draft delivery without executing them.
- [x] Review spec then code quality, resolve findings, rerun affected verification. No release/tag until separately requested for this new redesign.

## Acceptance checklist

- [x] Cover/title/body remain on one page; no bottom drawer or category tabs.
- [x] Cover card and draft cover agree; cover does not become a body illustration.
- [x] Requests return to current article only; three-cover progress is accurate.
- [x] Edited text changes stored article and rendered result; cancellation/failure preserves recoverable input; undo works.
- [x] No model call or new approval for direct preview/check. External delivery protection retained.
- [x] New and existing tests pass, built package works in installed host, real browser inspected.
- [x] User receives working page and concise evidence, with any actual blocker clearly distinguished.

## 2026-10-23 clarification — History owns reading, conversation owns editing

The user identified two problems during acceptance: the global history page exposed the entire editor outside its source conversation, and long content could not scroll. History now renders a read-only saved article/preview, explicitly labels missing or stale previews, and offers a source-conversation navigation action using the host's official `uiWorkspace.openSession`. It does not expose title/image generation, text changes, theme mutation, or draft delivery. The conversation sidebar retains those operations. The global main panel owns vertical scrolling inside the host's clipped column; article lists no longer add their own short nested scrollbar.

Verification: 826 tests passed across 60 files after this change; build/package passed. Browser acceptance confirmed history has no edit controls and the return action opens the exact conversation and article. Title save and paragraph save were exercised against the installed package in the isolated host. No real WeChat draft or paid image generation was performed.

Final verification: 830 tests / 60 files; lint and package build passed. Exact known-version revision compatibility added after real-user upgrade validation exposed the old-version identity mismatch. Installed package at dist/inline-review-04; original article now opens in the production profile. Real paid image generation and live draft delivery remain intentionally outside acceptance; tested via simulations. See docs/research/2026-10-23-inline-editor-acceptance.md for evidence and scope.
