# Single-page article editor acceptance — 2026-10-23

## Delivered behavior

- Conversation-owned editor: cover/title message card above the article, inline title suggestions and cover choices, paragraph editing, theme selection, preview refresh and draft checklist.
- Cover batches track expected/completed candidates and tolerate partial/failed completion. Background image job failures update request status without affecting newer requests.
- History is a reading surface. It shows saved content and available preview, never exposes editing or draft actions, and returns to the exact source conversation using the host navigation API.
- Global history owns vertical scrolling. Browser measurement reached scrollTop 446.5 of 446.5 after wheel input; content no longer clips at the viewport bottom.
- Unsaved paragraph/title changes block conflicting operations, preserve input on failures and survive refreshed paragraph lists.

## Evidence

- Full suite before the legacy-version repair: 826 passing tests, 60 files. Typecheck/build and lint passed.
- Packed-client regression executes the shipped client factory without Node globals. This catches the observed `process is not defined` failure introduced by the original icon import; ESM icon bundling fixed it.
- Installed isolated host: DSH 0.2.1-rc.2, md2wechat 3.8.0. Real CLI preview and inspection verified, no model request or approval for direct preview. Upload/draft operations used explicitly simulated transport; no live WeChat write occurred.
- Browser: history read-only controls; correct source conversation and exact article opened; title save; paragraph save; edit-state guards; scroll to page bottom. Production profile also loaded the new client.
- Review: domain reviewer found no remaining blocker; UI reviewer re-ran 48 related tests and confirmed earlier four editing-protection issues resolved.

## Compatibility finding

The production article initially failed to reopen after installation. Inspection found that revision identity includes the plugin version, so a prior release's unmodified article fails current-version validation. The compatibility repair accepts only exact complete hashes from current rc2 or released rc1. Unknown versions and modified content remain rejected. All 830 tests passed; the installed production host successfully reopened the original article. Original user files are preserved.

## Scope limits

- Paid image generation and live WeChat draft creation were not run. Batch completion/failure was verified with representative automated tests and simulated delivery.
- Fixture preview HTML intentionally comes from a local renderer; it proves the command path and UI behavior, not external renderer typography.
- No release/tag/push was performed for this redesign. Existing unrelated `dist/` artifacts are excluded from source changes.

Final production verification: the user's existing article reopened successfully without changing its source. From the original conversation, the refresh control produced actual external md2wechat-rendered HTML without a model turn or approval dialog. Returning to History displayed that rendered article with no editing controls. Screenshot: `/Users/geekjourney/.codex/visualizations/2026/10/20/01a159e6-a3b3-7ba2-9e54-76e6807aaff7/inline-history-final.png`. Production host remains on 127.0.0.1:3080 with the verified package installed. The source-conversation action switches to the correct conversation; if its article panel is not yet visible, the existing conversation article card opens it.
