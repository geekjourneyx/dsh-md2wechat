# Changelog

## Unreleased — 2.0.0-rc.1 (creator workspace refactor)

- Fixed `protocol/remote-info` loading on DSH 0.2.0-rc.2 by using the official 0.2.0 generator baseline without hand-written runtime shims. Both DSH 0.2.0-rc.2 and 0.2.1-rc.2 pass the installed HTTP/Remote and simulated-delivery matrix with CLI 3.3.0 and 3.8.0; peers permit only those two host versions. Browser/live-provider acceptance remains separate.
- Replaced the exact CLI 3.3.0 gate with protocol/capability validation and real runtime version provenance; changing the CLI invalidates old preview authority. Added 3.3.0/3.8.0 regression coverage. Earlier source-build users must create/review a new preview after recovery or explicit reimport. Compatible saved revisions can be recovered; revisions using the previous CLI-bound identity require importing the original or preserved article.md as a new source. Source-only revision identities no longer claim an unobserved CLI version, and old artifacts are retained rather than silently migrated.
- Default executable discovery uses the DSH host PATH; explicit absolute paths remain supported without silent fallback. Setup failures explain executable-file selection, process environment and restart requirements without exposing configured values.
- Added a native DSH web workspace opened by one article request, with real CLI layout previews, selectable API themes, mobile-width inspection and previous-preview comparison.
- Added host-agent suggestions with exact before/after review, explicit application or dismissal, undo and immutable revisions; original source files remain unchanged.
- Added validated local/host image candidates, explicit cover selection and conservative paragraph-based body placement. Fallback generation remains separately approved and uploads all generated candidates, not only selected ones.
- Extracted shared operations without removing existing tool schemas, approvals, credential handling or background jobs. Creator actions use the authenticated session workspace and current sandbox policy.
- **Breaking:** moved the strict host/client integration target from DSH 0.1.0-rc.5 to the tested 0.2.0-rc.2 / 0.2.1-rc.2 pair, requiring a new major plugin version. External CLI protocol and capabilities are checked before tool registration. Added portable client/Remote packaging and standalone builds without a sibling host checkout. No automatic host or CLI upgrade is performed.
- Added tag-triggered GitHub Release delivery: validate the tag against the package version and `main` ancestry, run validation/build/pack, and attach the prebuilt `.tgz` and `SHA256SUMS`. Release candidates are marked as prereleases; nothing is published to npm. The next release is planned as 2.0.0-rc.1 and remains unreleased until its tag is published.
- Made verified prebuilt Release assets the preferred installation route once available, with source builds as a developer fallback. Documented profile-lock `EPERM` before installation separately from host peer mismatches and CLI activation failures; Node.js 22.19.0 remains supported.
- Added native selected-asset delivery controls for approved uploads, review of the resulting final HTML, exact-byte export and unpublished drafts. These are current-branch features, not a shipped release claim; real-browser and live-service acceptance remain separate checks.
- Ordinary local HTML previews embed verified local image bytes before review and export the same portable bytes without requiring a cover or WeChat credentials.
- Added a fixed Articles navigation entry and independent main panel with explicit session selection; conversation cards now provide shortcuts instead of owning the editor.
- Persisted bounded article records and trusted session ownership independently from editable workspace data. Restore saved revisions, themes, image choices and undo history without restoring approvals, pending jobs or old review eligibility.
- Added explicit changed-source choices, legacy revision recovery, safe actionable errors and container-responsive layouts. Unknown delivery attempts remain blocked across restart until the user checks the external account.
- Validation covers fixtures, packed artifacts and official-host integration with loopback services. Paid providers, live WeChat delivery and real-browser acceptance are not claimed verified.

## 1.0.0 - 2026-08-28

- Added a standalone TypeScript DeepSeek Harness plugin for immutable Markdown article revisions, improvement requests, image planning, signed previews, and exact HTML export.
- Added optional, approval-gated creation of unpublished WeChat drafts from the current signed preview and verified uploaded images.
- Added doubly gated fallback image generation for cases where image work is required and the current DSH agent has no other image-generation capability. The operation may use the configured image provider and upload generated images to WeChat material storage.
- Added strict compatibility checks for a separately installed absolute-path md2wechat CLI at exactly version 3.3.0. The plugin package and Release do not include or install the CLI.
- Added workspace-local revision artifacts and external private state for image-plan and draft-operation authority.
- No publish or mass-send command is included. No npm publication is provided.
