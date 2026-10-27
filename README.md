# dsh-md2wechat

<img src="./assets/readme/readme-hero.webp" alt="dsh-md2wechat 插图：一份 Markdown 草稿变成排好版的文章。" width="100%">

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里把 Markdown 文章排成可审阅的公众号版式，比较主题，选择修改和图片，然后导出审阅过的 HTML，或保存一条未发布草稿。

当前包版本是 **2.0.0-rc.3**，GitHub Release `v2.0.0-rc.3` 标记为预发布。历史稳定标签 **v1.0.0** 是更早的工具流程，安装包和宿主版本都不同。对照见 [版本](#版本)。

[给 Agent 的安装说明](#给-agent-的安装说明) · [发给助手的安装提示词](#发给助手的安装提示词) · [安全边界](#安全边界) · [怎么使用](#怎么使用) · [English](#english)

## 给 Agent 的安装说明

按下面的顺序做。前一步的检查没有通过，就停，不要继续安装，也不要改 peer 范围、加版本豁免或使用 sudo。安装过程不要配置任何密钥。

本插件的压缩包和 GitHub Release 不附带 md2wechat，安装插件时也不会安装它。md2wechat 需要单独安装。

### 前置条件

同时满足下面四项：

1. 命令 `dsh` 可用。`dsh --version` 整行去掉空白后是 `0.2.0-rc.2` 或 `0.2.1-rc.2`。依据是 `package.json` 的 `peerDependencies`：`@deepseek-ai/dsh-agent` 等包只接受这两个版本。验收矩阵也按这两个宿主版本整套安装（`.github/workflows/creator-acceptance.yml`）。
2. Node.js 满足 `package.json` 的 `engines.node`：`^22.19.0` 或 `>=24.0.0`。
3. 能运行 `pnpm`。`@deepseek-ai/dsh@0.2.1-rc.2` 的说明写明，`dsh plugin --profile <name>` 后面的参数会转发给该 profile 目录里的 pnpm。没有 pnpm 时，执行 `npm --global install pnpm@11.7.0`，再开一个新终端。本仓库 `packageManager` 字段是 `pnpm@11.7.0`。
4. 能访问 GitHub，用来下载 Release 里的两个文件。

宿主还没安装时，先安装 DeepSeek Harness 的 `0.2.0-rc.2` 或 `0.2.1-rc.2`。本仓库不提供宿主安装包，插件也不会升级宿主。

### 需要的 md2wechat 版本

仓库没有把 CLI 锁死成单一版本号。插件激活时执行 `version --json` 和 `capabilities --json`（`src/index.ts`）。通过条件是：

- JSON 信封的 `schema_version` 为 `v1`（`src/cli/protocol.ts`）。
- `capabilities --json` 的 `data.commands` 包含 `src/cli/gateway.ts` 里的 `REQUIRED_CLI_COMMANDS`：`inspect`、`advise`、`preview`、`config`、`write`、`humanize`、`title`、`upload_image`、`download_and_upload`、`generate_image`、`generate_cover`、`generate_infographic`、`create_draft`、`providers`、`capabilities`、`version`。

验收矩阵实际安装的是 npm 包 `@geekjourneyx/md2wechat` 的 `3.3.0` 和 `3.8.0`（`.github/workflows/creator-acceptance.yml`）。给 Agent 的安装命令固定使用 **3.8.0**。2026-10-27 查询时，该包的 `latest` dist-tag 也是 `3.8.0`。

插件从 **DSH 宿主进程** 的 PATH 查找命令名 `md2wechat`。并列安装时，用绝对路径指向可执行文件，并让宿主进程看到 `MD2WECHAT_BINARY_PATH`。指向安装目录会失败。路径无效时插件直接报错，不会改用 PATH 里的另一个程序（`src/cli/gateway.ts`）。

### 安装并验证

下面这段给 macOS 和 Linux 的 `sh`。它安装 CLI、核对版本、下载插件压缩包、校验、安装到 web profile，并检查 `why` 的输出。它不会写入密钥，也不会启动长期运行的宿主。

```sh
set -eu

version=$(dsh --version | tr -d '[:space:]')
case "$version" in
  0.2.0-rc.2|0.2.1-rc.2) printf '%s\n' "$version" ;;
  *) printf 'unsupported dsh version: %s\n' "$version" >&2; exit 1 ;;
esac

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); const ok = (major === 22 && minor >= 19) || major >= 24; if (!ok) { console.error("Node " + process.versions.node + " is outside ^22.19.0 || >=24.0.0"); process.exit(1) } console.log(process.versions.node)'

command -v pnpm >/dev/null
pnpm --version

install_dir="$HOME/.local/lib/md2wechat"
mkdir -p "$install_dir"
npm --prefix "$install_dir" install @geekjourneyx/md2wechat@3.8.0
export MD2WECHAT_BINARY_PATH="$install_dir/node_modules/.bin/md2wechat"
test -x "$MD2WECHAT_BINARY_PATH"

"$MD2WECHAT_BINARY_PATH" version --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(j.code!=="VERSION_SHOWN"||j.schema_version!=="v1"||!j.data||j.data.version!=="3.8.0"){console.error(s); process.exit(1)} console.log(j.data.version)})'

"$MD2WECHAT_BINARY_PATH" capabilities --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const need=["inspect","advise","preview","config","write","humanize","title","upload_image","download_and_upload","generate_image","generate_cover","generate_infographic","create_draft","providers","capabilities","version"]; const commands=(j.data&&j.data.commands)||[]; const missing=need.filter(c=>!commands.includes(c)); if(j.schema_version!=="v1"||j.code!=="CAPABILITIES_SHOWN"||missing.length){console.error(missing.join(",")); process.exit(1)} console.log("capabilities ok")})'

plugin_dir="$HOME/.local/lib/dsh-md2wechat-plugin"
mkdir -p "$plugin_dir"
cd "$plugin_dir"
curl -fsSL -O https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v2.0.0-rc.3/geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz
curl -fsSL -O https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v2.0.0-rc.3/SHA256SUMS
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check SHA256SUMS
else
  shasum -a 256 --check SHA256SUMS
fi

dsh plugin --profile web add "$plugin_dir/geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz"
why_out=$(dsh plugin --profile web why @geekjourneyx/dsh-md2wechat)
printf '%s\n' "$why_out"
printf '%s\n' "$why_out" | grep -F '@geekjourneyx/dsh-md2wechat'
printf '%s\n' "$why_out" | grep -F '2.0.0-rc.3'
printf '%s\n' 'plugin 2.0.0-rc.3 and md2wechat 3.8.0 checks passed'
```

安装成功时应当看到：

- CLI 检查打印 `3.8.0`，以及 `capabilities ok`。`version --json` 的 `code` 是 `VERSION_SHOWN`，`data.version` 是 `3.8.0`。
- `why` 的输出里同时有包名 `@geekjourneyx/dsh-md2wechat` 和版本号 `2.0.0-rc.3`。看到 `1.0.0` 表示装到了旧包。
- 脚本最后一行是 `plugin 2.0.0-rc.3 and md2wechat 3.8.0 checks passed`。

然后在**同一个已经 export 过 `MD2WECHAT_BINARY_PATH` 的环境**里启动或重启宿主：

```sh
export MD2WECHAT_BINARY_PATH="$HOME/.local/lib/md2wechat/node_modules/.bin/md2wechat"
dsh --profile web
```

已经在跑的宿主读不到另一个终端里后设置的变量。Windows 上，把 `MD2WECHAT_BINARY_PATH` 指到同一 `node_modules/.bin` 目录里的 `md2wechat.cmd`。校验和可以用同一份 `SHA256SUMS`。本仓库的命令说明按 POSIX shell 编写。

需要换一种启动方式时，把 `binaryPath` 写成这个可执行文件的绝对路径，并保留 [配置](#配置) 里的 `credentialRefs`。只填目录路径会导致激活失败。

### 常见失败

- **`unsupported dsh version`：** 宿主版本不在 `0.2.0-rc.2` 与 `0.2.1-rc.2` 之中。`0.1.0-rc.5` 是 v1.0.0 的宿主目标，不能用来安装 2.0.0-rc.3。先更换宿主和网页客户端，再安装插件。
- **Node 检查退出码非 0：** 当前 Node 不满足 `^22.19.0` 或 `>=24.0.0`。换成满足该范围的 Node 后，从安装脚本重新执行。
- **找不到 `pnpm` 或 `dsh plugin` 无法转发：** 执行 `npm --global install pnpm@11.7.0`，打开新终端，确认 `pnpm --version` 打印 `11.7.0`，再从脚本里的 `dsh plugin add` 继续。
- **`sha256sum` 或 `shasum` 检查失败：** 不要执行 `add`。重新下载 `geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz` 和 `SHA256SUMS` 到同一目录后再检查。2026-10-27 用发布页上的这两个文件执行 `sha256sum --check SHA256SUMS` 的结果是 OK。
- **`why` 里没有 `2.0.0-rc.3`：** 核对 `add` 的文件名是 `geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz`。继续使用这一份 2.0.0-rc.3 压缩包。
- **激活时 md2wechat 探针未就绪：** 对 `MD2WECHAT_BINARY_PATH` 指向的文件再跑 `version --json` 和 `capabilities --json`。确认它是文件，宿主是带着这个变量启动的，并且 `commands` 含有上一节列出的命令。
- **profile 锁 `EPERM`：** 宿主在安装插件依赖之前无法访问 profile 锁。检查所选 profile 目录和当前用户的权限。不要使用 sudo。
- **peer 版本冲突：** 停止。不要强制安装依赖，不要放宽 `package.json` 里的 peer 范围。

从源码打包只用于修改本仓库的人。在仓库根目录使用 pnpm `11.7.0`：

```sh
git clone https://github.com/geekjourneyx/dsh-md2wechat.git
cd dsh-md2wechat
pnpm install --frozen-lockfile
pnpm pack --pack-destination ./dist
dsh plugin --profile web add ./dist/geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz
```

压缩包文件名里的版本与当时的 `package.json` `version` 相同。当前版本打出来的文件名是 `geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz`。

## 发给助手的安装提示词

把下面三行原样发给 DSH 里的助手：

```text
请按 dsh-md2wechat 仓库 README 的「给 Agent 的安装说明」安装当前预发布版。
不要配置任何密钥，密钥我自己在 DSH 凭据设置里填，也不要把密钥写进对话。
装完后告诉我你看到的插件版本号和 md2wechat 版本号。
```

## 安全边界

这些边界以当前代码为准。

- 安装步骤不读取、不写入密钥。插件配置里只有凭据引用名：`MD2WECHAT_API_KEY`、`WECHAT_APPID`、`WECHAT_SECRET`、`IMAGE_API_KEY`（`cordis.patch.yml`、`src/config.ts`）。
- 密钥由用户自己在 DSH 凭据设置里填写。插件通过 DSH 凭据服务按这些引用名读取（`src/security/credentials.ts`）。不要把密钥贴进聊天、文章、提示词或 patch。
- 预览收据里保存的是密钥的 SHA-256 派生值和 HMAC 签名，保存的内容不包括密钥原文（`src/workspace/preview.ts` 的 `accountProvenance` 与 `sign`）。
- 预览会把文章交给本机 md2wechat。插件执行 `preview`，并把 `MD2WECHAT_BASE_URL` 设为配置里的 `layoutBaseUrl`，默认是 `https://www.md2wechat.cn`（`src/config.ts`、`src/tools/preview.ts`）。文章因此会发到该排版服务。文章界面里的更新预览不再额外弹出一次授权；助手调用预览工具时仍走宿主授权。
- 保存草稿时，插件创建一条未发布的公众号草稿。授权说明写明这一步不发布、不群发（`src/tools/create-draft.ts`、`src/index.ts`、`src/creator/delivery.ts`）。插件没有注册群发或发布工具。
- 备用生图是另一条可选操作。它会生成图片，并把每一张请求的候选图上传到公众号素材库，包含没有被选中的候选；取消选择不会撤回已上传的文件（`src/creator/tool.ts`、`src/tools/generate-images.ts`）。这一步需要单独确认，并可能产生费用。

## 版本

| 项目 | 当前预发布 2.0.0-rc.3 | 历史 v1.0.0 |
|---|---|---|
| 发布状态 | GitHub Release `v2.0.0-rc.3` 标记为 prerelease。版本写在 `package.json` 和 `src/version.ts` 的 `PLUGIN_VERSION` | 稳定标签 `v1.0.0`，GitHub Release 未标记为 prerelease |
| 做什么 | 对话里的文章卡片和右侧文章栏：预览、改标题和正文、选图、导出或保存未发布草稿 | 更早的工具流程：修订、改进、配图计划、签名预览和导出 |
| 宿主 | DSH 宿主和 web 客户端 `0.2.0-rc.2` 或 `0.2.1-rc.2` | DSH `0.1.0-rc.5` |
| CLI | 协议 `v1` 加命令能力检查。验收跑过 `3.3.0` 和 `3.8.0`。Agent 安装使用 `3.8.0` | 当时要求 md2wechat 恰好 `3.3.0` |
| 安装包 | `geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz` | `geekjourneyx-dsh-md2wechat-1.0.0.tgz` |

从 v1 的宿主 `0.1.0-rc.5` 换到现在的 `0.2.0-rc.2` / `0.2.1-rc.2` 需要新的主版本插件。两份压缩包的文件名不同，不能互相覆盖使用。

只有在明确要恢复旧工具流程时，才安装 v1.0.0，并阅读 [v1.0.0 的 README](https://github.com/geekjourneyx/dsh-md2wechat/blob/v1.0.0/README.md)：

```sh
dsh plugin --profile web add https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v1.0.0/geekjourneyx-dsh-md2wechat-1.0.0.tgz
```

`CHANGELOG.md` 里 2.0.0-rc.3 的记录写明：本地安装、真实 CLI 预览，以及宽、窄布局做过浏览器核对。付费生图和真实公众号投递没有在那次核对里执行。

## 怎么使用

在对话里告诉助手要写什么。文章写好后，助手在当前对话创建文章卡片。作者不需要输入文件路径或选择会话。

界面文字以 `src/client` 为准：

1. 输入框旁的文章图标，可访问名称是「展开文章操作」。展开后按钮是「打开文章」。工具卡片上的按钮是「预览与调整文章」。右侧栏标签是「文章」。
2. 在文章栏用下拉框「排版主题」换主题。标题区有「编辑标题」「换个标题」「更换封面」。正文区有「编辑正文」，编辑时变为「查看效果」。配图和建议收在「正文配图与文字建议」里，其中有「请助手润色」「改进阅读体验」「为这个段落配图」。
3. 还没有预览时，按钮是「生成文章预览」。已有预览时，标题栏的按钮可访问名称是「更新预览」，悬停文字是「更新排版」。
4. 标题栏按钮「存为草稿」打开「保存到公众号草稿箱」。随后是「检查发布条件」「准备微信素材与最终预览」「审阅当前版本」。导出按钮是「导出已审阅 HTML」。勾选确认后，按钮是「确认保存到草稿箱」。
5. 左侧固定导航的名称是「文章历史」，用来找以前保存的文章。日常写作留在对话里。文章历史里的「选择已保存版本」只用于恢复旧版本记录。

对话里直接导入的正文上限是 2 MiB（`src/creator/import-source.ts`）。从工作区文件打开的文章上限是 8 MiB（`src/tools/start-article.ts`）。图片为 PNG、JPEG、GIF、WebP，上限 8 MiB。导入文本里若有非 `http`/`https` 的图片引用，需要改从原来的工作区文件打开，或先去掉这些引用。

文章栏会保存文章身份、修订引用、主题、已选封面、候选引用和撤回记录。重启后，未完成的建议和生图任务不会自动重放，已有的预览审阅也不会恢复。上传或草稿如果结果不明，插件会挡住下一次自动投递，需要先到公众号后台核对。

普通 HTML 导出使用已经审阅的内容。本地图片会先嵌入，再按那些字节复制。这一步不需要封面、生图或公众号密钥。已有的微信图片 URL 保持远程引用。

备用生图只在当前助手没有别的生图能力时使用。提供者由宿主环境里的 `IMAGE_PROVIDER`、`IMAGE_API_BASE`、`IMAGE_MODEL`、`IMAGE_SIZE` 决定。插件接受的提供者名称是 OpenAI、ModelScope、OpenRouter、Volcengine、Tuzi；Tuzi 必须另外给出 HTTPS 的 `IMAGE_API_BASE`（`src/creator/image-provider.ts`）。

## 主题与模块

数字来自 2026-10-27 安装的 `@geekjourneyx/md2wechat@3.8.0`。

- `md2wechat themes list --json` 返回 53 条。其中 `type` 为 `api` 的 49 条，`type` 为 `ai` 的 4 条。`api-collection` 的 `selectable` 为 false。
- 插件的「排版主题」下拉只保留 `type === "api"` 且 `selectable === true`、名称符合 `^[\w-]{1,100}$` 的主题（`src/creator/session.ts` 的 `selectableThemes`）。按这条规则，3.8.0 的下拉是 **48** 套。4 条 ai 主题和不可选的 `api-collection` 不会出现在下拉里。
- `md2wechat layout list --json` 默认列出 recommended 模块，`data.count` 为 **59**，`data.modules` 长度也是 59。`capabilities --json` 里的 `layout.module_count` 同样是 59。
- `md2wechat layout list --json --lifecycle compatibility` 返回 2 个模块。插件界面没有模块选择列表。

## 配置

随包 patch 读取可选的 `MD2WECHAT_BINARY_PATH`。未设置时使用宿主 PATH 上的 `md2wechat`。凭据引用如下。

| 引用名 | 用途 |
|---|---|
| `MD2WECHAT_API_KEY` | 排版预览，以及已审阅结果的校验 |
| `WECHAT_APPID`、`WECHAT_SECRET` | 上传公众号素材，创建未发布草稿 |
| `IMAGE_API_KEY` | 可选的备用生图 |

`enableWechatWriteTools` 和 `enableFallbackImageTool` 的默认值都是 `true`（`src/config.ts`）。打开开关不等于批准某一次操作。要保留草稿、关闭备用生图时，在 profile 的 `cordis.patch.yml` 里写完整的一行。DSH 会替换该行的整个 `config`，所以可执行文件和凭据引用要一起留下：

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

`enableWechatWriteTools: false` 会关掉草稿和备用生图工具。备用生图同时要求两个开关都为 true。

修订文件默认在工作区的 `.dsh/md2wechat`。图片计划和操作记录默认在 `$DSH_HOME/plugins/dsh-md2wechat`；未设置 `DSH_HOME` 时为 `~/.dsh/plugins/dsh-md2wechat`（`src/config.ts`）。

## 开发与检查

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm run check:boundaries
pnpm run build
pnpm run pack:check
```

[安装验收](./scripts/creator-host-acceptance/README.md) 使用打好的包和 DSH 宿主。[浏览器工作流](./.github/workflows/creator-acceptance.yml) 覆盖已安装的文章主面板。这些检查不代替付费生图或真实公众号账号的验收。

Release 由与 `package.json` 版本一致、且指向 `main` 上提交的 `v*` 标签触发。工作流发布 `.tgz` 和 `SHA256SUMS`。像 `2.0.0-rc.3` 这样的预发布版本会标成 prerelease。合并 PR 本身不会发布。

更新记录见 [CHANGELOG.md](./CHANGELOG.md)。

## English

The commands and expected version numbers are in [给 Agent 的安装说明](#给-agent-的安装说明). Run that script unchanged. This section keeps the same facts.

**Versions.** The package version is the prerelease `2.0.0-rc.3` (`package.json`, `PLUGIN_VERSION` in `src/version.ts`). GitHub Release `v2.0.0-rc.3` is marked as a prerelease. Historical tag `v1.0.0` is the earlier tool-based release for DSH `0.1.0-rc.5` and, at that time, an md2wechat CLI pinned to `3.3.0`. Installing the current creator workspace uses `geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz`. Use the v1 archive only when that older workflow is required:

```sh
dsh plugin --profile web add https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v1.0.0/geekjourneyx-dsh-md2wechat-1.0.0.tgz
```

**CLI.** Install `@geekjourneyx/md2wechat@3.8.0`. Activation accepts a separate `md2wechat` CLI with the supported `v1` JSON protocol and the required commands in `src/cli/gateway.ts`. CI also installs `3.3.0` (`.github/workflows/creator-acceptance.yml`). The plugin archive and its GitHub Release do not contain or install md2wechat.

**Success.** `version --json` shows `VERSION_SHOWN` and `data.version` `3.8.0`. `dsh plugin --profile web why @geekjourneyx/dsh-md2wechat` shows `@geekjourneyx/dsh-md2wechat` and `2.0.0-rc.3`. Restart `dsh --profile web` from the environment that exports `MD2WECHAT_BINARY_PATH` to `$HOME/.local/lib/md2wechat/node_modules/.bin/md2wechat`. On Windows, point that variable at `md2wechat.cmd` in the same `.bin` directory.

**Prompt to send.** Ask the assistant to follow 「给 Agent 的安装说明」, skip credential setup, and report the plugin version and the md2wechat version it observed.

**Boundaries.** Fill `MD2WECHAT_API_KEY`, `WECHAT_APPID`, `WECHAT_SECRET`, and `IMAGE_API_KEY` in DSH credential settings. Do not paste them into chat. Preview runs the local `preview` command with `MD2WECHAT_BASE_URL` defaulting to `https://www.md2wechat.cn`, so the article is sent to that layout service. A saved draft never publishes or mass-sends. Fallback generation runs only when the current DSH agent has no other image-generation capability; it uploads every requested candidate to WeChat material storage.

**Screen labels.** Open the article with 「打开文章」 or 「预览与调整文章」. The sidebar entry is 「文章历史」. The editor is one page: 「排版主题」, 「编辑标题」, 「换个标题」, 「更换封面」, 「编辑正文」, 「存为草稿」, then 「确认保存到草稿箱」.

**Counts on md2wechat 3.8.0.** `themes list --json` returns 53 themes. The theme menu keeps 48 API themes that are selectable. `layout list --json` returns 59 recommended modules. Compatibility lifecycle returns 2 more, and the plugin UI has no module list.
