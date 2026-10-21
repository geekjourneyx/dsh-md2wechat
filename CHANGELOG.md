# Changelog

## 2.0.0-rc.1 - 2026-10-21

- Fixed article loading dependencies, direct conversation-text import, title/preview consistency and safe image-byte import. Simplified article controls and collapsed internal suggestion requests in the conversation.

- Fixed `protocol/remote-info` loading on DSH 0.2.0-rc.2 by using the official 0.2.0 generator baseline without hand-written runtime shims. Both DSH 0.2.0-rc.2 and 0.2.1-rc.2 pass the installed HTTP/Remote and simulated-delivery matrix with CLI 3.3.0 and 3.8.0; peers permit only those two host versions. Browser/live-provider acceptance remains separate.
- Replaced the exact CLI 3.3.0 gate with protocol/capability validation and real runtime version provenance; changing the CLI invalidates old preview authority. Added 3.3.0/3.8.0 regression coverage. Earlier source-build users must create/review a new preview after recovery or explicit reimport. Compatible saved revisions can be recovered; revisions using the previous CLI-bound identity require importing the original or preserved article.md as a new source. Source-only revision identities no longer claim an unobserved CLI version, and old artifacts are retained rather than silently migrated.
- Default executable discovery uses the DSH host PATH; explicit absolute paths remain supported without silent fallback. Setup failures explain executable-file selection, process environment and restart requirements without exposing configured values.
- Added a native DSH web workspace opened by one article request, with real CLI layout previews, selectable API themes, mobile-width inspection and previous-preview comparison.
- Added host-agent suggestions with exact before/after review, explicit application or dismissal, undo and immutable revisions; original source files remain unchanged.
- Added validated local/host image candidates, explicit cover selection and conservative paragraph-based body placement. Fallback generation remains separately approved and uploads all generated candidates, not only selected ones.
- Extracted shared operations without removing existing tool schemas, approvals, credential handling or background jobs. Creator actions use the authenticated session workspace and current sandbox policy.
- **Breaking:** moved the strict host/client integration target from DSH 0.1.0-rc.5 to the tested 0.2.0-rc.2 / 0.2.1-rc.2 pair, requiring a new major plugin version. External CLI protocol and capabilities are checked before tool registration. Added portable client/Remote packaging and standalone builds without a sibling host checkout. No automatic host or CLI upgrade is performed.
- Added tag-triggered GitHub Release delivery: validate the tag against the package version and `main` ancestry, run validation/build/pack, and attach the prebuilt `.tgz` and `SHA256SUMS`. Release candidates are marked as prereleases; nothing is published to npm. Version 2.0.0-rc.1 is a prerelease; live-service production acceptance is not claimed.
- Made verified prebuilt Release assets the preferred installation route once available, with source builds as a developer fallback. Documented profile-lock `EPERM` before installation separately from host peer mismatches and CLI activation failures; Node.js 22.19.0 remains supported.
- Added native selected-asset delivery controls for approved uploads, review of the resulting final HTML, exact-byte export and unpublished drafts. Live-service acceptance remains a separate check.
- Ordinary local HTML previews embed verified local image bytes before review and export the same portable bytes without requiring a cover or WeChat credentials.
- Made the current conversation the primary article entry: a persistent article card opens the native right sidebar for preview, layout, titles, images and draft preparation. The separate navigation entry is article history; ordinary users do not enter file paths.
- Persisted bounded article records and trusted session ownership independently from editable workspace data. Restore saved revisions, themes, image choices and undo history without restoring approvals, pending jobs or old review eligibility.
- Added explicit changed-source choices, legacy revision recovery, safe actionable errors and container-responsive layouts. Unknown delivery attempts remain blocked across restart until the user checks the external account.
- Validated 796 tests and 32 isolated host checks on DSH 0.2.1-rc.2 with CLI 3.8.0, plus manual browser checks of the conversation/sidebar flow. The older host/CLI matrix was not rerun for this redesign. Paid providers, live WeChat delivery and the native image-file picker remain outside completed acceptance.

## 1.0.0 - 2026-08-28

- Added a standalone TypeScript DeepSeek Harness plugin for immutable Markdown article revisions, improvement requests, image planning, signed previews, and exact HTML export.
- Added optional, approval-gated creation of unpublished WeChat drafts from the current signed preview and verified uploaded images.
- Added doubly gated fallback image generation for cases where image work is required and the current DSH agent has no other image-generation capability. The operation may use the configured image provider and upload generated images to WeChat material storage.
- Added strict compatibility checks for a separately installed absolute-path md2wechat CLI at exactly version 3.3.0. The plugin package and Release do not include or install the CLI.
- Added workspace-local revision artifacts and external private state for image-plan and draft-operation authority.
- No publish or mass-send command is included. No npm publication is provided.
