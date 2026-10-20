# Installed creator acceptance

This harness installs the supplied package into an isolated profile using published
DSH 0.2.0-rc.2 or 0.2.1-rc.2. A test-only LlmAdapter emits a genuine tool call: the real Agent loop
executes the tool and persists its native card. No synthetic tool/result event or
standalone mock UI substitutes for the installed extension.

## Run from the repository

```sh
pnpm exec node scripts/creator-host-acceptance/run.mjs \
  --package /absolute/path/to/geekjourneyx-dsh-md2wechat-2.0.0-rc.1.tgz \
  --host /absolute/path/to/installed-dsh-prefix \
  --cli /absolute/path/to/official-md2wechat-3.3.0 \
  --root /absolute/path/to/acceptance-results \
  --online
```

The host prefix must contain node_modules/@deepseek-ai/dsh. Install official pinned
packages with npm --prefix into dedicated directories. Each harness run creates an
append-only child directory under --root; it never cleans existing directories.
Choose a root outside the platform temporary directory (for example, not under
`/tmp` on Linux): the real plugin correctly rejects temporary state authority.
Omit --online to use cached dependencies; optionally supply --store /absolute/path
and the XDG cache/data/state directories associated with that pnpm store.

This command is separate from the historical `pnpm test:installed` source-build test.
The CI workflow `.github/workflows/creator-acceptance.yml` pins Node 24, pnpm 11.7.0,
Playwright 1.58.2 and the four combinations of DSH 0.2.0-rc.2 / 0.2.1-rc.2
with md2wechat 3.3.0 / 3.8.0. No account secrets are required.

## Safety boundaries

By default WeChat-write and fallback-image tools are disabled. Official CLI discovery,
themes and preview are real; rendering uses a loopback fake API and non-secret fixture
key. Ambient and home/workspace config deliberately specify unreachable loopback,
while the signed plugin endpoint points to the real fixture server. Successful preview
therefore verifies that ambient configuration cannot redirect article content or keys.

`--simulate-writes` enables a test-only executable bridge. Only upload_image and
create_draft return strict simulated v1 envelopes; those commands never invoke the
real CLI or WeChat. Generation/download-write commands are refused. Fake WeChat
credentials exist only in the isolated profile. This proves integration and duplicate
suppression, NOT real external upload/draft service behavior.

`--fixture-only` checks the legacy tool trajectory only. Its report is explicitly
labelled and is not creator acceptance or proof of creator safety boundaries.

## HTTP and Remote assertions

- Package SHA256, published host version, real profile install and HTTP authentication.
- Real Agent-loop tool call/result with creator presentation metadata.
- Read-only/outside-workspace, cross-session and missing-session denial.
- Effective theme selection and optimistic-version rejection.
- Official CLI preview, conflicting endpoint override, renderer failure visibility.
- Real approval IDs paired inside balanced official turns; no preview model request.
- Review bound to current publication title, preview path and SHA256; wrong hash denied.
- Original Markdown preserved.

With --simulate-writes, the harness additionally imports two cover candidates and one
body image, selects one cover, places the body image, and verifies:

- Portable preview embeds the PNG and needs no separate local assets.
- Reviewed local export equals preview bytes before any upload occurs.
- Only selected cover and placed body image are uploaded by the simulated bridge.
- Prepared final preview, reviewed export and simulated draft HTML are byte-identical.
- Completed/uncertain draft outcomes cannot issue duplicate external writes.
- Deterministic delivery operations do not request a model.

Immediate sequential actions are used without a test idle-delay workaround.

## Browser and screenshot gate

On a compatible runner add:

```sh
--browser --playwright /absolute/node_modules/playwright-core/index.mjs
```

Optionally supply --chromium /absolute/chromium; otherwise Playwright's installed
Chromium is used. The browser authenticates through the actual host, opens the real
session card, refreshes/reviews, selects another theme, opens 改进, and receives a
proposal through the real md2wechat_propose_changes tool and Agent loop.

Screenshots capture desktop (1600×1100) error, reviewed preview, alternate theme and
suggestion review, plus narrow (430×932) page/workspace. A browser failure screenshot
is retained when possible. Remote requests are blocked; only the loopback host and
data/blob resources are allowed. Screenshots show actual product UI with deterministic
fixture content, not production-provider typography. A failed or unrequested browser
gate is never reported as passed. Do not retry Chromium in a socket-restricted runner.

## Evidence and verified scope

Each run prints a report and retains logs/report.json, trajectory.json,
preview-audit.json, renderer-requests.json, host stdout/stderr, install.log, optional
simulated-writes.jsonl and browser PNGs. Launch tokens are redacted; full model/system
prompts are excluded. CI uploads only this evidence folder for seven days.

On 2026-10-20 the full HTTP/Remote gate passed against archive SHA256
83c191f0087fb09e47c59c9bc203fbbfec8ab4356fcce0c8c2020ed20bf308ba, including portable
export, endpoint challenge, simulated delivery, and immediate sequential actions.
Model request count remained 3; host stderr was empty; exit status was 0.
Browser screenshots and actual WeChat writes were not verified by that run.
