# dsh-md2wechat

Prepare Markdown articles for WeChat from DeepSeek Harness with reviewable, approval-gated steps.

[![Release](https://img.shields.io/github/v/release/geekjourneyx/dsh-md2wechat?label=release)](https://github.com/geekjourneyx/dsh-md2wechat/releases/tag/v1.0.0)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![md2wechat CLI](https://img.shields.io/badge/md2wechat%20CLI-3.3.0-2f855a.svg)](https://github.com/geekjourneyx/md2wechat-skill)

`dsh-md2wechat` is an installable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for building an immutable article revision, improving it, planning images, producing a signed preview, and exporting the reviewed HTML. Optional tools can generate missing images through md2wechat's configured image service and create an unpublished WeChat draft.

It is not the md2wechat CLI, an image model, or a publishing bot. The plugin and its GitHub Release do not contain or install md2wechat, and there is no command to publish or mass-send an article.

## Install

Requirements:

- DeepSeek Harness with `dsh` and `pnpm` available.
- Node.js `^22.19.0` or `>=24.0.0`.
- A separately installed `md2wechat` CLI at exactly version `3.3.0`.
- An absolute path to that executable in `MD2WECHAT_BINARY_PATH` before the profile starts.

Install the prebuilt, platform-independent plugin archive into a DSH profile:

```sh
dsh plugin --profile web add https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v1.0.0/geekjourneyx-dsh-md2wechat-1.0.0.tgz
```

Confirm the dependency and composed configuration:

```sh
dsh plugin --profile web why @geekjourneyx/dsh-md2wechat
dsh --profile web --dump-config
```

The Release contains only the plugin. Install md2wechat 3.3.0 separately, set `MD2WECHAT_BINARY_PATH` to its absolute executable path, then start the profile. Plugin activation fails before registering tools if the executable is missing, reports another version, or lacks a required command.

## Credentials and configuration

The bundled patch reads `MD2WECHAT_BINARY_PATH` and uses these default DSH credential references:

| Reference | Used for |
|---|---|
| `MD2WECHAT_API_KEY` | Signed preview validation, preview generation, export validation, and draft creation |
| `WECHAT_APPID` | Fallback image upload and unpublished draft creation |
| `WECHAT_SECRET` | Fallback image upload and unpublished draft creation |
| `IMAGE_API_KEY` | Fallback generation through the image service configured by md2wechat |

Credential references are names resolved by DSH; do not place credential values in the patch or a prompt.

The plugin row can be replaced in a later profile patch. Because a DSH patch replaces the row's complete `config`, restate the executable and credential references when changing a feature gate. For example, keep draft creation but disable fallback image generation:

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

Save this row in the profile's `cordis.patch.yml`. Later layers override the bundle defaults.

## Tools and feature gates

The six base tools are always available after successful activation:

| Tool | Purpose |
|---|---|
| `md2wechat_doctor` | Check the configured CLI, version, capabilities, and provider readiness without exposing credentials |
| `md2wechat_start_article` | Copy a workspace Markdown file into a new immutable article revision without changing the source |
| `md2wechat_improve_article` | Prepare advice or a rewrite request for the current revision without modifying its bytes |
| `md2wechat_plan_images` | Create replayable image plans without credentials, generation, or uploads |
| `md2wechat_preview` | Create an expiring signed HTML preview after one-time approval |
| `md2wechat_export` | Copy the exact current signed preview HTML to an approved absolute local destination |

Optional tools follow both gates exactly:

| `enableWechatWriteTools` | `enableFallbackImageTool` | Additional tools |
|---|---|---|
| `false` | `false` or `true` | None |
| `true` | `false` | `md2wechat_create_draft` |
| `true` | `true` | `md2wechat_create_draft`, `md2wechat_generate_images` |

Both gates default to `true`. `md2wechat_create_draft` creates one unpublished WeChat draft from the exact signed preview and verified uploaded images. `md2wechat_generate_images` must be used only when image work is required and the current DSH agent has no other image-generation capability.

## Workflow

Use this order:

1. `md2wechat_start_article` or `md2wechat_improve_article`
2. `md2wechat_plan_images`
3. `md2wechat_preview`
4. `md2wechat_export` or, when enabled, `md2wechat_create_draft`

When the article needs images and the agent has no other image-generation capability, run `md2wechat_generate_images` after planning and before producing the final preview or draft.

Example prompt:

```text
Prepare article.md as a WeChat article, plan the required images, let me review the signed preview, then export the approved HTML. Use md2wechat fallback image generation only if you have no other image-generation capability.
```

## Approvals and side effects

- Preview requires one-time approval before md2wechat generates signed preview HTML through the configured provider. It writes revision-local preview artifacts.
- Export requires one-time approval bound to the exact signed HTML and absolute destination. It performs no CLI or network call, but writes the approved local file.
- Fallback generation requires one-time approval. It can incur image-provider usage, download the result, and upload it to WeChat material storage before saving verified local artifacts. It runs as a background job when work remains.
- Draft creation requires one-time approval. It uses already-uploaded body images and one verified cover to create an unpublished WeChat draft. It never publishes or mass-sends.

Planning, previewing, exporting, generating images, and creating a draft are separate decisions. A preview or export does not imply approval to generate, upload, or create a draft.

## Compatibility and security

- Plugin version: `1.0.0`.
- External md2wechat CLI: exactly `3.3.0`; other versions fail activation.
- Node.js: `^22.19.0` or `>=24.0.0`.
- The plugin archive is platform-independent. Platform support for the external CLI is the CLI distributor's responsibility.
- Revision artifacts stay inside the session workspace at `.dsh/md2wechat` by default.
- Image-plan and draft-operation authority stays outside the workspace and temporary directories at `$DSH_HOME/plugins/dsh-md2wechat` by default. Configure an absolute external `stateDir` when that default overlaps a workspace.
- Credentials are resolved only for the approved operation that needs them. The plugin does not print credential values or store them in article artifacts.
- md2wechat is a trusted external executable. Review and install it separately; the plugin does not sandbox or update it.

## Troubleshooting

**The plugin registers no tools.** Check that `MD2WECHAT_BINARY_PATH` is absolute, points to an executable md2wechat 3.3.0, and that `md2wechat version --json` plus `md2wechat capabilities --json` succeed.

**A preview, export, image job, or draft reports missing credentials.** Add the named credential to DSH and keep the corresponding `credentialRefs` entry. Do not paste a credential into the prompt or patch.

**Fallback generation is unavailable.** Both `enableWechatWriteTools` and `enableFallbackImageTool` must be `true`. Prefer another agent image capability when one is available.

**The state directory is rejected.** Use an absolute private directory outside the session workspace, the artifact directory, and platform temporary directories.

**A draft outcome is unknown.** The plugin blocks automatic retry after a started operation without an authenticated completion result, preventing an accidental duplicate draft. Inspect the WeChat account before deciding on any manual recovery.

## Development

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm run check:boundaries
pnpm run build
pnpm run pack:check
```

The test suite uses controlled fixtures and installed-package acceptance without making paid provider, image-generation, WeChat, publication, mass-send, or browser calls.

## License

[MIT](./LICENSE) © 2026 geekjourneyx. See [CHANGELOG.md](./CHANGELOG.md) for the current release.
