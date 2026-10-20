# Changelog

## Unreleased — creator workspace refactor

- Added a native DSH web workspace opened by one article request, with real CLI layout previews, selectable API themes, mobile-width inspection and previous-preview comparison.
- Added host-agent suggestions with exact before/after review, explicit application or dismissal, undo and immutable revisions; original source files remain unchanged.
- Added validated local/host image candidates, explicit cover selection and conservative paragraph-based body placement. Fallback generation remains separately approved and uploads all generated candidates, not only selected ones.
- Extracted shared operations without removing existing tool schemas, approvals, credential handling or background jobs. Creator actions use the authenticated session workspace and current sandbox policy.
- Pinned the host/client integration target to DSH 0.2.1-rc.2 and retained external md2wechat CLI 3.3.0. Added portable client/Remote packaging and standalone builds without a sibling host checkout. No automatic host or CLI upgrade is performed.
- Added native selected-asset delivery controls for approved uploads, review of the resulting final HTML, exact-byte export and unpublished drafts. These are current-branch features, not a shipped release claim; real-browser and live-service acceptance remain separate checks.
- Ordinary local HTML previews embed verified local image bytes before review and export the same portable bytes without requiring a cover or WeChat credentials.
- Active creator selections and review authority remain session-memory state; restarting requires reopening and reviewing the article.
- Validation covers fixtures, packed artifacts and official-host integration with loopback services. Paid providers, live WeChat delivery and real-browser acceptance are not claimed verified.

## 1.0.0 - 2026-08-28

- Added a standalone TypeScript DeepSeek Harness plugin for immutable Markdown article revisions, improvement requests, image planning, signed previews, and exact HTML export.
- Added optional, approval-gated creation of unpublished WeChat drafts from the current signed preview and verified uploaded images.
- Added doubly gated fallback image generation for cases where image work is required and the current DSH agent has no other image-generation capability. The operation may use the configured image provider and upload generated images to WeChat material storage.
- Added strict compatibility checks for a separately installed absolute-path md2wechat CLI at exactly version 3.3.0. The plugin package and Release do not include or install the CLI.
- Added workspace-local revision artifacts and external private state for image-plan and draft-operation authority.
- No publish or mass-send command is included. No npm publication is provided.
