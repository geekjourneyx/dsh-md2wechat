# dsh-md2wechat

Open a Markdown article in DeepSeek Harness, review its real WeChat layout, choose improvements and images, then take away the reviewed HTML or an unpublished draft.

[![Release](https://img.shields.io/github/v/release/geekjourneyx/dsh-md2wechat?label=release)](https://github.com/geekjourneyx/dsh-md2wechat/releases/tag/v1.0.0)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![md2wechat CLI](https://img.shields.io/badge/md2wechat%20CLI-3.3.0-2f855a.svg)](https://github.com/geekjourneyx/md2wechat-skill)

The creator workspace is an **unreleased refactor** on this branch. It uses DSH's native web client, not a separate website. The published 1.0.0 archive below is the earlier tool-based release; do not assume it includes the new workspace.

The plugin and its GitHub Release do not contain or install md2wechat. It never publishes or mass-sends.

## Install and compatibility

For this branch, use a coordinated **DSH 0.2.1-rc.2** host and web client. This is the pinned integration target; compatibility with DSH 0.1.0-rc.5 or other versions is not claimed. The plugin does not upgrade your host or CLI automatically.

You also need:

- Node.js `^22.19.0` or `>=24.0.0`, with `dsh` and `pnpm` available.
- A separately installed `md2wechat` CLI at exactly version `3.3.0`.
- `MD2WECHAT_BINARY_PATH` set to the absolute executable path before starting the profile.
- A session workspace containing your Markdown and any local images.

The plugin archive is platform-independent; external CLI platform support is the CLI distributor's responsibility.

For the published, tool-based 1.0.0 release:

```sh
dsh plugin --profile web add https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v1.0.0/geekjourneyx-dsh-md2wechat-1.0.0.tgz
```

For this unreleased branch, use a tarball supplied with the reviewed PR/build artifact, or build one from this repository. Install that downloaded/local archive rather than the old release URL:

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination ./dist
dsh plugin --profile web add ./dist/geekjourneyx-dsh-md2wechat-1.0.0.tgz
```

Verify the installed dependency and composed configuration, then restart the profile so its host and client load the same package:

```sh
dsh plugin --profile web why @geekjourneyx/dsh-md2wechat
dsh --profile web --dump-config
```

No sibling DeepSeek Harness checkout is required to build this branch. Activation fails before tool registration if the configured CLI is missing, has another version, or lacks a required command.

## Start with your article

Ask your DSH agent:

```text
Open article.md in the WeChat creator workspace. Keep my source unchanged; let me review the layout and choose any changes.
```

The agent opens `md2wechat_open_workspace`. From its native card:

1. Generate a real layout preview, approving the configured layout-service request when prompted. This sends article content to that service; it is not an offline Markdown preview.
2. Choose an available API theme and compare successful previews at 320, 375 or 390 px. A failed refresh retains the previous preview but marks it stale.
3. Optionally request reading improvements, title suggestions or light polishing. Review up to three exact before/after changes, apply one, or keep the original. Undo restores the previous content; a changed version needs a new preview and review.
4. Add images only if helpful. Choose a cover candidate explicitly, or select a supported body paragraph and place, replace or remove its image.
5. Review the current preview and export its HTML to a workspace destination. No image generation, cover or WeChat credential is required for ordinary HTML export. Verified local images are embedded before review so the exported file remains usable outside the article workspace. Existing WeChat image URLs are preserved, not downloaded. Other remote image hosts are rejected with an import-local-image prompt because the protected preview cannot display them.

The review panel shows the actual publication title returned by the layout service, including front-matter title precedence. Confirm that title rather than assuming the source heading is the publication title.

The original source file stays unchanged. Changes and imported images belong to article revisions. Suggestions use the existing host agent; clicking a specific theme or accepting a specific change does not ask a model to reinterpret your selection.

### Images are choices, not automatic uploads

Prefer the host's existing image capability or **Use an existing local image**. Imported PNG, JPEG, GIF and WebP files must be inside the session workspace and pass validation. Adding a local candidate does not select it or upload it.

A cover request asks for three candidates; body candidates belong to a specific paragraph. Complex positions inside code, YAML front matter, lists, tables, quotes, raw HTML and custom modules are not offered. The plugin does not guess where to insert an image into those structures.

Use fallback generation only when the current DSH agent has no other image-generation capability. CLI 3.3.0 fallback **generates and uploads every requested candidate to WeChat material storage**, including candidates you never select. It may incur provider charges and requires separate one-time approval. Deselecting an image does not undo uploads or charges. Background work must finish before its results can be used.

Fallback provider configuration comes from the DSH host environment, never article-directory configuration: `IMAGE_PROVIDER`, `IMAGE_API_BASE`, `IMAGE_MODEL` and `IMAGE_SIZE`. Supported CLI 3.3.0 providers are OpenAI, ModelScope, OpenRouter, Volcengine and Tuzi; Tuzi requires an explicit HTTPS API base. The approval names the destination origin. Unsupported or ambiguous provider configuration fails closed.

### Final delivery with WeChat images

For WeChat-ready delivery, use the current branch’s final delivery controls:

1. Choose one cover and the body images you want to retain.
2. Explicitly prepare delivery: approve uploads of the selected cover and current local body images only. Unselected local candidates are excluded. This does not reverse uploads already made by fallback generation.
3. Review the resulting final HTML after its verified local image references have been replaced with WeChat material URLs.
4. Approve either export of those exact HTML bytes or creation of one unpublished WeChat draft using those bytes and the selected cover. Draft creation requires a cover; ordinary HTML export does not.

Do not treat the pre-upload preview as approval of a changed final document. Content, theme or selection changes invalidate the relevant review. These controls are implemented on this branch; real-browser and live-service acceptance remain separate release checks.

## Credentials and configuration

The bundled patch reads `MD2WECHAT_BINARY_PATH` and resolves these credential references through DSH:

| Reference | Purpose |
|---|---|
| `MD2WECHAT_API_KEY` | Layout preview and authentication of reviewed output |
| `WECHAT_APPID`, `WECHAT_SECRET` | WeChat material uploads and unpublished draft creation |
| `IMAGE_API_KEY` | Optional fallback image provider |

Configure values in DSH's credential service, not in article text, prompts or patches. Credentials are resolved for the operation that needs them and are not stored in article artifacts.

Both write and fallback feature gates default to `true`; enabling a gate does not grant approval for an operation. To keep draft creation but disable fallback generation, use this later profile patch row. DSH replaces the row's complete `config`, so retain the executable and credential references:

```yaml
- id: dsh-md2wechat
  config:
    binaryPath: !!js process.env.MD2WECHAT_BINARY_PATH
    credentialRefs:
      MD2WECHAT_API_KEY: MD2WECHAT_API_KEY
      WECHAT_APPID: WECHAT_APPID
      WECHAT_SECRET: WECHAT_SECRET
      IMAGE_API_KEY: IMAGE_API_KEY
    enableWechatWriteTools: true
    enableFallbackImageTool: false
```

Save the row in the profile's `cordis.patch.yml`. Setting `enableWechatWriteTools: false` disables draft/fallback tools; fallback requires both gates. Existing approvals remain separate: preview, upload/generation, export and draft creation do not authorize one another.

## Troubleshooting and advanced use

- **Nothing loads:** check the pinned host/client versions, the absolute CLI path, `md2wechat version --json` and `md2wechat capabilities --json`. After installing this refactor, restart the profile and open a new workspace card. Old generic tool cards do not turn into creator workspaces.
- **Read-only or outside-workspace error:** creator actions respect the session's current sandbox policy and canonical workspace boundary. Use a permitted location or change policy through the host; the plugin does not grant itself access. Export can replace an existing destination only after the host approval.
- **Expired or stale preview:** refresh and review again. Preview receipts expire; there is no fixed lifetime promised by this plugin. Browser rendering is isolated and is not a guarantee of pixel-identical rendering in every WeChat client.
- **Restarted or reopened session:** active creator choices, pending suggestions and review authority are in memory. Reopen the article and review again; persisted revision files are not a promise of automatic UI-session recovery.
- **Missing credentials:** add the named reference in DSH. Do not paste secrets into the conversation.
- **State directory rejected:** revision artifacts default to `.dsh/md2wechat` inside the workspace. Private image-plan and operation authority defaults to `$DSH_HOME/plugins/dsh-md2wechat` (or `~/.dsh/plugins/dsh-md2wechat`). Set an absolute `stateDir` outside workspaces, artifacts and temporary directories if those overlap.
- **Upload or draft result unknown:** inspect the WeChat account before recovery. A started operation without authenticated completion is not automatically retried, to avoid duplicate effects. The CLI itself can retry uploads internally; the approval describes that boundary.

Advanced callers can still use `md2wechat_doctor`, `md2wechat_start_article`, `md2wechat_improve_article`, `md2wechat_plan_images`, `md2wechat_preview` and `md2wechat_export`. Optional `md2wechat_create_draft` and `md2wechat_generate_images` retain their feature gates and approval checks. These legacy tools remain compatible interfaces, not the primary author checklist or a way around review requirements.

md2wechat is a separately trusted executable. The plugin does not install, update or independently sandbox it; use the host's execution controls and review its configuration.

## Development and verification

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm run check:boundaries
pnpm run build
pnpm run pack:check
```

Verification uses controlled fixtures, real packed-package loading and the pinned official DSH host with loopback services. This is not verification of paid image providers or a live WeChat account. Real-browser acceptance remains a release gate; do not infer it from unit or package-test success.

## License

[MIT](./LICENSE) © 2026 geekjourneyx. See [CHANGELOG.md](./CHANGELOG.md) for release status.
