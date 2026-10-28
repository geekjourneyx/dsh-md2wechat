# dsh-md2wechat

<img src="./assets/readme/readme-hero.webp" alt="dsh-md2wechat：从 Markdown 草稿到公众号文章的创作插画，非产品截图。" width="100%">

**DSH 一站式公众号创作插件**

在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 中完成公众号写作、文字润色、标题优化、排版和配图，预览确认后导出 HTML 或保存到公众号草稿箱。排版与交付能力由 [md2wechat](https://github.com/geekjourneyx/md2wechat-skill) 提供。

[![许可证：AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![DSH 兼容版本](https://img.shields.io/badge/DSH-0.2.0--rc.2%20%7C%200.2.1--rc.2%20%7C%200.2.1--rc.4-475569.svg)](./package.json)

[功能介绍](#功能介绍) · [安装](#安装) · [开始创作](#开始创作) · [配置](#配置) · [常见问题](#常见问题)

> 当前版本 **2.0.0-rc.3** 为预发布版，可从 [发布页](https://github.com/geekjourneyx/dsh-md2wechat/releases/tag/v2.0.0-rc.3) 下载。历史 v1.0.0 是更早的工具流程，使用不同的宿主版本。

## 功能介绍

| 功能 | 可以做什么 |
|---|---|
| 对话写作 | 在 DSH 中描述选题，让助手写成文章，并直接打开文章编辑器 |
| 文字润色 | 获取修改建议、比较前后差异，选择采用或继续编辑正文 |
| 标题优化 | 直接修改标题，或让助手提供新的标题建议 |
| 主题排版 | 切换公众号主题，查看实际排版效果 |
| 高级排版模块 | 在正文中使用 md2wechat 的模块语法，制作主视觉、提示卡片等版式，再通过预览检查效果 |
| 封面与正文配图 | 导入本地图片或使用生图能力，选择封面，并为指定段落配图 |
| 导出与草稿 | 导出已审阅的 HTML，或准备微信素材后保存到公众号草稿箱 |
| 文章历史 | 保存文章、主题、图片选择和修订记录，继续之前的创作 |

高级排版模块由 md2wechat 的 API 排版服务处理，插件没有单独的模块选择面板。模块用法见 [高级排版指南](https://github.com/geekjourneyx/md2wechat-skill/blob/main/docs/LAYOUT.md)，实际效果以当前服务返回的预览为准。

md2wechat 还提供多公众号账号配置，以及微信接口 IP 白名单和固定出口的接入说明。插件当前使用 DSH 中配置的一组公众号凭据，不提供界面内多账号切换或批量投递；相关配置见 [多账号与 IP 白名单](#多账号与-ip-白名单)。完整能力与配置文档请查看 [md2wechat-skill](https://github.com/geekjourneyx/md2wechat-skill)。

## 安装

### 环境要求

- **DSH 宿主与网页客户端：** 使用相互匹配的 `0.2.0-rc.2`、`0.2.1-rc.2` 或 `0.2.1-rc.4`。
- **Node.js：** `^22.19.0` 或 `>=24.0.0`，且 `dsh` 命令可用。
- **包管理器：** 通过 npm 启动的 DSH 需要可用的 pnpm；打包宿主可能已内置。源码构建使用 pnpm `11.7.0`。
- **md2wechat CLI：** 单独安装，支持 `v1` JSON 协议及插件需要的命令。`3.3.0` 和 `3.8.0` 是回归验证目标，不是唯一允许的版本。
- **工作区：** Markdown 文件和本地图片放在当前会话工作区内。
- **凭据：** 预览和导出需要排版服务的 API Key；保存公众号草稿及备用生图另需相应凭据，见 [配置](#配置)。

### 先安装 md2wechat CLI

```sh
npm install -g @geekjourneyx/md2wechat
```

具体配置文档可查看 [md2wechat-skill](https://github.com/geekjourneyx/md2wechat-skill)。已有兼容版本可以继续使用；插件及其发布包不包含、也不会自动安装或升级 md2wechat。

安装后可检查版本和能力：

```sh
md2wechat version --json
md2wechat capabilities --json
```

插件启动时还会检查协议和必需命令，不会仅凭版本号判断兼容。外部 CLI 的平台支持以其发行说明为准。

### 安装插件

**DSH `0.2.1-rc.4` 用户：** 当前源码已加入兼容支持。已发布的 `2.0.0-rc.3` 安装包仍只支持前两个宿主版本；新版安装包发布前，请使用下方「从源码构建」步骤，不要强制安装旧包。

从 [v2.0.0-rc.3 发布页](https://github.com/geekjourneyx/dsh-md2wechat/releases/tag/v2.0.0-rc.3) 下载 `geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz` 和 `SHA256SUMS`，放在同一目录，先校验：

```sh
sha256sum --check SHA256SUMS
```

macOS 可改用：

```sh
shasum -a 256 --check SHA256SUMS
```

确认校验成功后，在该目录安装：

```sh
dsh plugin --profile web add ./geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz
```

使用发布包不需要克隆或构建本仓库。插件通过 GitHub 发布包分发，不是通过 npm 安装；前面的 npm 命令安装的是 md2wechat CLI。

插件从 **DSH 宿主进程的 PATH** 查找 `md2wechat`。如果单独安装在其他位置，启动 DSH 前设置可执行文件的绝对路径：

```sh
# 替换为你实际安装的可执行文件路径，不要填写目录。
export MD2WECHAT_BINARY_PATH=/absolute/path/to/md2wechat
```

从同一终端启动或重启 DSH。在另一个终端设置变量，不会改变已经运行的宿主。也可以在配置中设置 `binaryPath`，并保留 [配置](#配置) 中的凭据引用。指定路径无效时插件会报错，不会自动换用其他程序。

### 检查并启用

```sh
dsh plugin --profile web why @geekjourneyx/dsh-md2wechat
dsh --profile web --dump-config
```

确认安装的插件版本是 `2.0.0-rc.3`，然后重启对应配置的 DSH，让宿主和网页客户端加载同一版本。CLI 缺失或不兼容时，插件会停止启用并提示原因。用户自行在 DSH 中添加所需凭据后，即可打开文章生成预览。

### 交给助手安装

把下面这段发给助手：

```text
请阅读 https://github.com/geekjourneyx/dsh-md2wechat 的 README，按「安装」章节安装 2.0.0-rc.3 预发布版。
先检查环境；尚未安装 md2wechat CLI 时，执行 npm install -g @geekjourneyx/md2wechat，已有兼容版本则继续使用。
不要强制安装不兼容版本，不要配置或读取密钥。完成后告诉我实际看到的插件版本和 md2wechat 版本。
```

<details>
<summary>从源码构建</summary>

仅修改本仓库时需要。在 pnpm `11.7.0` 环境下运行，无需另行克隆 DSH 源码：

```sh
git clone https://github.com/geekjourneyx/dsh-md2wechat.git
cd dsh-md2wechat
pnpm install --frozen-lockfile
pnpm pack --pack-destination ./dist
dsh plugin --profile web add ./dist/geekjourneyx-dsh-md2wechat-2.0.0-rc.3.tgz
```

这里打包的是当前源码，文件名中的版本取自 `package.json`。

</details>

<details>
<summary>安装历史 v1.0.0</summary>

v1.0.0 使用早期工具流程，目标宿主是 DSH `0.1.0-rc.5`。仅在明确需要旧版时使用，并阅读 [旧版说明](https://github.com/geekjourneyx/dsh-md2wechat/blob/v1.0.0/README.md)：

```sh
dsh plugin --profile web add https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v1.0.0/geekjourneyx-dsh-md2wechat-1.0.0.tgz
```

</details>

## 开始创作

在 DSH 对话里告诉助手要写什么。文章生成后，点击「打开文章」或工具卡片上的「预览与调整文章」，在右侧文章栏继续编辑，对话和输入框仍然可用。

1. 用「排版主题」切换主题，直接编辑标题，或请求新标题。
2. 点击「编辑正文」修改内容，也可让助手润色或改善阅读体验，再决定采用哪些建议。
3. 选择封面和正文图片，为指定段落配图。
4. 生成或更新预览，检查最终标题、正文和图片。
5. 点击「存为草稿」，完成素材准备和审阅后「确认保存到草稿箱」；只需本地文件时可导出已审阅的 HTML。

插件只保存未发布草稿，不发布、不群发。发布前仍需到公众号后台确认。

源文件不会被覆盖。对话导入正文上限为 2 MiB，工作区文件上限为 8 MiB，图片上限为 8 MiB，支持 PNG、JPEG、GIF、WebP。含本地或相对图片引用的正文，应从原工作区文件打开，或先替换这些引用。

### 预览与定稿

预览会把文章发送到配置的排版服务，并非离线排版。文章界面的预览操作直接执行；助手发起的预览工具调用仍需宿主授权。

- 刷新失败时保留上一次结果，但会标记为过期。
- 检查服务返回的实际公众号标题，文章头部信息可能影响最终标题。
- 正文、主题或图片变化后，需要重新预览和审阅。
- 普通 HTML 导出会在审阅前嵌入经过检查的本地图片，导出内容与审阅结果一致，不需要封面、生图或公众号凭据。
- 已有微信图片链接保持远程引用；其他远程图片需先导入本地，受保护的预览不会直接显示它们。

预览采用隔离显示，不能保证与每一种微信客户端逐像素一致。

### 配图

优先使用本地图片或 DSH 已有的生图能力。图片须位于当前工作区并通过检查；导入候选图片不会自动选中或上传。

封面生成会请求三个候选。正文图片关联到指定段落，可放置、替换或移除；不会猜测代码、文章头部信息、列表、表格、引用、原始 HTML 或自定义模块内部的插图位置。

<details>
<summary>备用生图及上传说明</summary>

仅当当前助手没有其他生图能力时，才使用 CLI 备用生图。它会生成并上传每张请求的候选图到微信素材库，包括最终未选中的图片，可能产生费用，执行前需要单独确认。取消选择不会撤回已经上传的素材或费用。

备用生图读取宿主环境中的 `IMAGE_PROVIDER`、`IMAGE_API_BASE`、`IMAGE_MODEL`、`IMAGE_SIZE`。当前插件接受 OpenAI、ModelScope、OpenRouter、Volcengine、Tuzi；Tuzi 需要明确的 HTTPS API 地址。不支持或含糊的配置会被拒绝。

</details>

### 保存到公众号草稿箱

1. 选择一个封面和需要保留的正文图片。
2. 确认准备微信素材：只上传当前选中的封面和本地正文图片，未选中的本地候选不会上传；之前备用生图产生的上传不会撤回。
3. 本地图片替换为微信素材链接后，检查最终预览和公众号标题。
4. 审阅当前版本，再导出 HTML，或确认保存一条未发布草稿。

上传、生图、导出和保存草稿分别确认。上传前的审阅不能代替对最终内容的审阅。上传或保存结果不明时，应先到公众号后台核对；插件不会自动重复投递。

### 继续之前的文章

从「文章历史」选择同一会话，继续已保存文章。主题、图片选择、修订和撤回记录会保留；共享目录的不同会话仍有各自的文章列表。

重启不会重放未完成的建议或生图任务，也不会恢复旧预览的审阅授权。继续交付前需重新预览和审阅。原 Markdown 已变化时，明确选择保存版本或导入新文章。

旧版只有修订文件、没有文章记录时，可用「选择已保存版本」恢复兼容修订。恢复不会删除旧文件，也不会猜测原始文件路径或还原从未保存的选择。若旧格式无法恢复，可把保留的 `article.md` 作为新文章打开。

## 配置

插件通过 DSH 凭据服务读取以下引用：

| 引用名 | 用途 |
|---|---|
| `MD2WECHAT_API_KEY` | 排版预览与已审阅结果校验 |
| `WECHAT_APPID`、`WECHAT_SECRET` | 上传微信素材、创建公众号草稿 |
| `IMAGE_API_KEY` | 可选备用生图 |

由用户在 DSH 中配置密钥，不要写进聊天、正文或插件配置文件。凭据只在需要时读取，不保存在文章文件中。排版使用 md2wechat API 服务，需要有效的 API Key；服务范围与费用见 [md2wechat 文档](https://github.com/geekjourneyx/md2wechat-skill#专业-api)。

### 多账号与 IP 白名单

- **多公众号账号：** md2wechat CLI 支持命名账号及指定目标账号，配置方法见 [多账号配置文档](https://github.com/geekjourneyx/md2wechat-skill/blob/main/docs/CONFIG.md)。当前插件保存草稿时使用 DSH 配置的 `WECHAT_APPID` 和 `WECHAT_SECRET`，不会自动采用 CLI 的命名账号列表。使用其他公众号前，需配置对应的 DSH 凭据，并重新预览、核对目标账号和确认保存。
- **IP 白名单：** 调用微信接口需要满足账号的 IP 白名单要求。配置步骤见 [微信凭证与 IP 白名单指南](https://github.com/geekjourneyx/md2wechat-skill/blob/main/docs/WECHAT-CREDENTIALS.md)。md2wechat 高级 API 服务可提供固定出口能力，具体开通条件以服务说明为准；插件不会自动修改微信后台白名单。

### 可选功能开关

草稿与备用生图开关默认开启，但不代表批准了具体操作。若要保留草稿、关闭备用生图，可在对应配置目录的 `cordis.patch.yml` 中加入下面的配置。DSH 会替换整段 `config`，因此需保留路径和凭据引用：

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

`enableWechatWriteTools: false` 会关闭草稿和备用生图工具；备用生图需要两个开关都开启。

修订文件默认位于工作区的 `.dsh/md2wechat`。私有图片计划和操作记录默认位于 `$DSH_HOME/plugins/dsh-md2wechat`，未设置 `DSH_HOME` 时使用 `~/.dsh/plugins/dsh-md2wechat`。

## 常见问题

<details>
<summary>安装、恢复与权限问题</summary>

- **配置目录锁报 `EPERM`：** 宿主无法访问配置目录锁，发生在插件依赖安装前。检查目录权限和宿主允许的访问范围，不要使用 `sudo` 绕过。
- **宿主版本不匹配：** 当前插件支持 DSH `0.2.0-rc.2`、`0.2.1-rc.2` 或 `0.2.1-rc.4`，不支持 v1 使用的 `0.1.0-rc.5`。不要强制安装不兼容依赖；插件不会升级宿主。
- **CLI 无法启用：** 检查可执行文件路径、宿主 PATH，以及 `version --json`、`capabilities --json` 的输出。更换 CLI 后需要重新预览和审阅。
- **旧包提示 `protocol/remote-info` 缺失：** 在受支持的宿主中安装修正后的插件包，不要修改宿主导出或强行放宽版本要求。
- **安装后没有文章入口：** 确认宿主和客户端版本匹配，重启后从「文章历史」选择会话，或在对话里请助手重新打开文章。
- **文件只读或在工作区外：** 使用会话允许的位置，或通过宿主调整访问权限。插件不会自行扩大权限；覆盖导出文件也需确认。
- **旧文章或快捷入口无法恢复：** 选择兼容的已保存版本，或把原 Markdown、保留的 `article.md` 重新打开为新文章，再生成和审阅预览。不会自动迁移或降低检查要求。
- **缺少凭据：** 在 DSH 中添加相应引用，不要把密钥贴进对话。
- **状态目录被拒绝：** 自定义 `stateDir` 必须是位于工作区、文章产物和临时目录之外的绝对路径。
- **上传或草稿结果不明：** 先到微信后台核对，再明确恢复。重开面板不会自动重试；CLI 内部可能重试上传，确认时会说明这一点。

</details>

md2wechat 是独立运行的外部程序，插件不会安装、升级或单独隔离它，请使用宿主的执行控制并检查其配置。

## 开发与验证

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm run check:boundaries
pnpm run build
pnpm run pack:check
```

[安装验收说明](./scripts/creator-host-acceptance/README.md) 使用真实打包产物和官方 DSH 宿主；[浏览器验收流程](./.github/workflows/creator-acceptance.yml) 用于检查安装后的文章界面、窄屏布局和对话入口。

已在 DSH `0.2.1-rc.4` 与 CLI `3.8.0` 上完成自动化验证：831 项测试通过，并在真实宿主与浏览器中检查了文章入口、标题和正文编辑、换主题、应用建议、文章历史、窄屏显示、刷新及重启恢复、审阅与导出。排版使用本地测试服务，图片上传和存草稿使用模拟微信写入；不代表付费生图或真实公众号投递已验证。

持续集成包含三种受支持的 DSH 版本与 CLI `3.3.0`、`3.8.0` 的六组组合，具体通过状态以对应运行结果为准。

发布由 `v*` 标签触发，标签需与包版本一致且指向 `main` 上的提交。发布流程检查、构建并上传 `.tgz` 和 `SHA256SUMS`，预发布版本会标为预发布；合并 PR 本身不会发布，也不会上传到 npm。

## 许可证

本项目采用 [AGPL-3.0 许可证](./LICENSE)（`AGPL-3.0-only`）。md2wechat CLI 和外部服务遵循各自的许可与服务条款。

© 2026 geekjourneyx · [更新记录](./CHANGELOG.md)
