# Changelog

## 1.0.0 - 2026-08-28

- Added a standalone TypeScript DeepSeek Harness plugin for immutable Markdown article revisions, improvement requests, image planning, signed previews, and exact HTML export.
- Added optional, approval-gated creation of unpublished WeChat drafts from the current signed preview and verified uploaded images.
- Added doubly gated fallback image generation for cases where image work is required and the current DSH agent has no other image-generation capability. The operation may use the configured image provider and upload generated images to WeChat material storage.
- Added strict compatibility checks for a separately installed absolute-path md2wechat CLI at exactly version 3.3.0. The plugin package and Release do not include or install the CLI.
- Added workspace-local revision artifacts and external private state for image-plan and draft-operation authority.
- No publish or mass-send command is included. No npm publication is provided.
