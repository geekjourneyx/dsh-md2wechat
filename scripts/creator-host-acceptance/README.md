# Installed article-panel acceptance

This harness installs one supplied archive into an isolated profile using published
DSH 0.2.0-rc.2 or 0.2.1-rc.2. It never rebuilds or repacks that archive. The test-only
LlmAdapter emits a genuine tool call, executed by the real Agent loop. A second,
retained session starts without any message or tool call, so the fixed article panel
must work independently of a chat card.

## Run the installed-package gate

```sh
node scripts/installed-acceptance.mjs \
  --package /absolute/path/to/geekjourneyx-dsh-md2wechat-2.0.0-rc.1.tgz \
  --host /absolute/path/to/installed-dsh-prefix \
  --cli /absolute/path/to/official-md2wechat-3.3.0 \
  --root /absolute/path/to/acceptance-results \
  --online --simulate-writes
```

The direct entry `scripts/creator-host-acceptance/run.mjs` accepts the same arguments.
The host prefix must contain `node_modules/@deepseek-ai/dsh`. Install official pinned
packages into dedicated prefixes. Each run creates an append-only child directory
under `--root`; it never cleans an existing directory. Use a root outside the platform
temporary directory: the real plugin rejects temporary state authority. Omit `--online`
for cached dependencies; `--store /absolute/path` selects a prepared pnpm store.

The old environment-variable invocation of `pnpm test:installed` remains available
for source-build host diagnostics. Its report explicitly does not claim installed
article-panel or browser acceptance. For the release gate, supply `--package` and run
exactly the same archive against both hosts and both official CLI versions, 3.3.0
and 3.8.0; compare `packageSha256` across all four reports.

## Safety boundaries

WeChat-write and fallback-image tools are disabled by default. CLI discovery, themes
and preview are real; rendering uses a loopback fake API and a non-secret fixture key.
Ambient and home/workspace configuration deliberately point at unreachable loopback,
while the signed plugin endpoint selects the fixture server. A successful preview
therefore checks that ambient configuration cannot redirect article content or keys.

`--simulate-writes` enables a test-only executable bridge. Only `upload_image` and
`create_draft` return strict simulated v1 envelopes; they never invoke WeChat or the
real CLI. Generation and download-write commands are refused. Fixture credentials
exist only in the isolated profile. This verifies integration and duplicate
suppression, not a real WeChat service or paid-provider transaction.

The historical-card fixture copies a completed genuine fixture session through the
official Agent seed API, replacing only creator result metadata with an intentionally
obsolete article ID. It is labelled as historical fixture data in the report; it is
not proof of an actual customer's old session. Product document records are not edited.

`--fixture-only` is limited to the legacy tool trajectory. It does not claim the
article-panel, restart, delivery or browser gates.

## HTTP/Remote and real-host restart gate

The normal non-browser run checks:

- Archive SHA256, published host identity, real profile installation and HTTP auth.
- Genuine Agent tool call/result metadata and a distinct retained blank session.
- Explicit session-bound `list`, `open`, `get` and `resume`; same-source stable IDs;
  shared-directory cross-session isolation and missing-session denial.
- Read-only/outside-workspace denial, theme selection and stale-version rejection.
- Real CLI preview, signed-endpoint override and visible renderer failure.
- Real approval IDs within balanced official turns, without a preview model request.
- Review binding to current title, preview path and hash; original Markdown unchanged.
- Actual host process termination and fresh startup against the same profile/state.
  The fixture uses official `agents.resume` with the original session IDs, never a
  silent replacement session or a new model prompt. Boot IDs exclude stale audit files.
- Restored article ID, Markdown, theme, candidates, cover and undo availability;
  cleared review and pending requests; zero automatic model, renderer or simulated
  writes. Before shutdown, a genuine `request-suggestions` call is asserted pending
  while the offline adapter holds its output until host cancellation. The model-count
  baseline is taken after that authorized request has entered the hold.
- Write-permission revocation after opening: the official read-only sandbox mode
  must still permit `list`, `get` and `resume`, but refuse a mutation without model,
  renderer or simulated-write effects. This does not claim actual filesystem-read
  revocation coverage; that boundary remains covered by product unit tests.

With `--simulate-writes`, selected-only image uploads, portable local export, final
preview/export/draft byte equality and completed/unknown duplicate suppression are
also asserted. After restart, an unknown-delivery barrier must remain even after
explicitly refreshing and re-reviewing the preview. Both draft and material preparation
must remain blocked, with no additional bridge write. Immediate actions are used,
without a test-only idle-delay workaround.

## Browser and screenshot gate

Only on a runner where browser launch is permitted, append:

```sh
--browser --playwright /absolute/node_modules/playwright-core/index.mjs
```

Optionally add `--chromium /absolute/chromium`; otherwise use Playwright's installed
Chromium. Do not attempt this flag in the executor where Chromium launch was denied.
Do not substitute data URLs, a standalone component or a generated image. The existing
GitHub Actions workflow is the browser route for that environment after the branch is
pushed. A configured workflow is not evidence of a queued or passing run.

The browser opens the official fixed “文章” navigation with no selected session,
explicitly selects the blank session, imports Markdown without a tool call, previews,
changes theme and applies a real tool-produced suggestion. It switches to the native
message card and back, refreshes, and checks the same saved article. The stale
historical card must show an actionable recovery state without scanning automatically;
only “选择已保存版本”, an explicit manifest choice and “恢复所选版本” may restore it.
After a real host restart, the browser restores the unreviewed article, explicitly
refreshes/reviews again and exports exactly the displayed preview bytes.

Screenshots include fixed navigation, 1440px main workspace, an applied edit, 360px /
768px / 1440px panel layouts, historical recovery prompt and chosen-version recovery,
restart restoration and reviewed export. Narrow layouts assert no document or panel
horizontal overflow. A failure screenshot is retained when possible. Browser requests
are limited to the loopback installed host and data/blob resources. Fixture content is
not production-provider typography.

## Evidence and status

Each run retains `logs/report.json`, `trajectory.json`, `before-restart-audit.json`,
`preview-audit.json`, `renderer-requests.json`, host stdout/stderr, install log, optional
simulated-write log and browser PNGs. Launch tokens are redacted. Full model/system
prompts and real credentials are excluded. CI uploads only the evidence folder.

The browser report is `not-requested`, `pending`, `failed` or `passed`; only a completed browser
gate becomes `passed`. Unit tests or an HTTP/Remote pass do not prove the UI gate.
These expanded assertions require a fresh run of the integrated archive. Historical
pre-panel acceptance evidence must not be presented as acceptance of this feature.
