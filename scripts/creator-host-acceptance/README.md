# Installed creator acceptance harness

These are test-only artifacts, not product changes. `run.mjs` creates an append-only
isolated directory for every run. It installs the supplied packed product with the
published DSH CLI, starts the host and a local renderer together, and shuts down both.
The fake LLM adapter is registered through the official LlmAdapter interface. It emits
a genuine tool call; the real Agent loop persists the resulting native tool card.
No manually invented tool/result event or direct tool-only execution stands in for
that trajectory. Separate direct calls are used only for sandbox-negative probes.

## Local invocation

XDG_DATA_HOME=/tmp/dsh-pnpm/data XDG_CACHE_HOME=/tmp/dsh-pnpm/cache XDG_STATE_HOME=/tmp/dsh-pnpm/state \
node /workspace/shared/dsh-host-acceptance/task8/run.mjs \
  --package /absolute/path/to/geekjourneyx-dsh-md2wechat-1.0.0.tgz \
  --host /workspace/shared/dsh-installed-host \
  --cli /tmp/md2wechat-cli-check/install/node_modules/@geekjourneyx/md2wechat/bin/md2wechat \
  --root /workspace/shared/dsh-host-acceptance/task8-results \
  --store /tmp/dsh-pnpm/store

`--online` permits package-manager dependency resolution when no offline store exists.
This does not enable any paid model/image/rendering endpoint. The host gets only a
fixed non-secret fixture key and an ephemeral loopback renderer URL, also written in
its isolated md2wechat config. Image generation and WeChat-write tools are disabled.

`--fixture-only` substitutes legacy md2wechat_start_article and verifies only the real
fake-model/tool trajectory. It is NOT acceptance of the creator feature or its safety
boundaries. This was used successfully to validate the fixture against the Task1 pack.

## Browser gate

On a compatible CI runner add:
  --browser --playwright /absolute/node_modules/playwright-core/index.mjs
Optionally add `--chromium /absolute/chromium`. Otherwise use Playwright's installed
Chromium. Do not retry Chromium locally in the current socket-restricted executor.

The browser authenticates through the real launch URL, opens `离线验收会话` in the
native session sidebar, finds the actual `文章工作区` region created from persisted
presentation metadata, refreshes preview, reviews it, and captures before/after PNGs.
Browser selection labels intentionally match the production Chinese UI. If UI labels
change, update this test alongside the product; do not inject a standalone mock card.

## Checks and evidence

- packed package SHA256 and published host version
- official profile install and HTTP authentication
- real Agent-loop tool/call plus tool/result with creator presentation metadata
- read-only and outside-workspace open denial
- cross-session article ownership and missing-session denial
- effective theme selection and optimistic-version rejection
- real official CLI preview against local API
- no extra model request during Remote preview
- real approval asked/decided paired by ID inside balanced official turns
- review and visible renderer failure state
- original Markdown unchanged
- optional actual browser card interaction and screenshots

Each run prints a small report and stores logs/report.json, trajectory.json,
renderer-requests.json, host.stdout.log, host.stderr.log, install.log, and browser PNGs.
Launch tokens are redacted. Full model/system prompt events are deliberately excluded.
`browser: not-requested` is not a browser pass. A failed assertion exits nonzero and
retains diagnostics. A passed fixture-only run is explicitly labelled.

The CI job is .github/workflows/creator-acceptance.yml. It pins published DSH
0.2.1-rc.2, md2wechat 3.3.0, Playwright 1.58.2, pnpm 11.7.0 and Node 24.
No secrets are required. Use pnpm exec node scripts/creator-host-acceptance/run.mjs
with the flags above from the repository; this is separate from the historical
pnpm test:installed source-build acceptance script.

## Integration boundary and verified result

The new packed product must expose md2wechat_open_workspace and Remote get/dispatch.
Task1's pack exposes only session and cannot pass the full creator test. Remote preview
must respect DSH's turn-enclosed approval audit contract: real ApprovalService.request
throws outside an open Agent turn. The fixture's test approval answerer does not bypass
that contract. A product failure here is intentionally reported rather than hidden by
patching approval.request or forging a turn/result.

Corrected stage3 package SHA256 fbae3db1aa9b6b267437bc11607baebdebba79f3c3ff7f5fe72fe38faa0bba64
passed all HTTP/Remote assertions on published rc.2. Preview added official turn 2,
approval asked/decided seq29/30 inside start/end seq27/31, and model count stayed 3.
Browser remains a separate CI gate, not a claimed local pass.

The fixture configures the product via an ID-targeted startup patch, not a live
loader update. This removes the fixture-induced transient fiber-state warning.
A second complete HTTP run passed with zero host stderr bytes. The test does not
silence host diagnostics, modify product injection, or replace approval services.

## Screenshot review gate

Push/PR and workflow_dispatch run the real installed native tool card in Chromium.
Evidence includes desktop (1600×1100) renderer error, reviewed preview, selected
alternative theme, and suggestion-before/after state, plus narrow (430×932) page
and workspace captures. The local fixture LLM submits suggestions through the real
md2wechat_propose_changes tool and real Agent loop. No synthetic card is injected.
The renderer response and model suggestion are deterministic offline test data;
these screenshots prove actual product UI, not a production rendering-provider theme.
