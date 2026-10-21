> **2026-10-21 用户纠偏覆盖说明：** 主流程必须在当前对话内：共同写作 → 文章卡片 → 侧边阅读/标题/排版/配图 → 草稿确认。独立入口仅用于文章历史。下文原“全局文章主工作区”“导入引导”“路径和旧版本恢复 UI”不再作为普通用户交付要求；直接传入对话正文和实际文件选择替代手输路径。权限、原文保护、预览一致性和草稿防重复要求保持。

# DSH Article Experience Repair Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划默认由当前执行者顺序完成，不主动分派子智能体。

**Goal:** 修好文章打开，让正文成为页面中心，并打通导入、排版、标题、配图、预览到保存公众号草稿的完整流程。

**Architecture:** 沿用 DSH 的主面板、会话授权和现有 CreatorService。文章入口负责找到内容，主区域负责阅读，按需工具栏负责调整；保存流程组织现有素材准备、审阅和草稿动作，不绕过原有授权和防重复保护。保留现有文档存储和远程契约，只有确实缺少的导入、直接改标题和交付状态才作增量扩展。

**Tech Stack:** TypeScript、React 18、现有 DSH Remote、Vitest；浏览器实际验收使用当前环境提供的浏览器工具。

**Spec:** `docs/research/2026-10-20-article-experience-review.md`。用户于 2026-10-21 明确要求三项都纳入。本计划将诊断中的建议收敛为以下实施范围，不表示产品已经修改或通过验收。

## Global Constraints

- 保持 DSH `0.2.0-rc.2`、`0.2.1-rc.2` 支持；CLI `3.3.0`、`3.8.0` 为现有回归目标；Node `^22.19.0 || >=24.0.0`，pnpm `11.7.0`。
- 使用已安装版本可用的 DSH 主题与控件，不能把上游最新版文档里才出现的能力当成本机已有。不得以升级宿主代替兼容修复。
- 原文不覆盖，所有明确选择可追溯；继续保存文章不重新发起模型请求、生图、素材上传或草稿提交。
- 会话自动选择只来自当前宿主明确上下文或已保存且仍可访问的选择；不能猜测同目录其他会话的文章。
- 用户不必手输路径即可完成正常创作；文件路径和版本恢复放进“更多”。
- 确定操作直接执行；模型只用于提出候选和表达复杂意图。
- 默认对一个已配置公众号保存草稿，不增加多账号管理系统；明确目标账号，不伪造账号名称或草稿查看链接。
- 外部排版传输、付费图片生成、图片上传、保存草稿遵守现有授权。计划本身不授权真实公众号写入或收费生成。
- 不制作独立网站，不换框架，不引入整套新组件库，不加入与文章任务无关的装饰。
- 不把模拟写入当作真实微信成功；实际服务未验收时，交付报告必须明确剩余范围。

## Review Focus

1. 切换会话后迟到的请求不能将旧文章显示到新会话：任务 1、2 验收。
2. 中文、空格、重名、目录外文件及相对图片引用不能造成错读或覆盖：任务 3、6 验收。
3. 快速换主题、改标题后旧预览不能被当成当前成品：任务 5、7 验收。
4. 重启、断网、上传成功但草稿响应丢失不能导致丢进度或重复写入：任务 1、7、8 验收。
5. 深色、窄屏、键盘操作、没有任何会话或排版未配置时，用户仍能理解并继续：任务 2、4、8 验收。

## 完成定义与执行顺序

完成标准：用户不写路径、不理解内部会话，也能导入一篇文章，选择排版，改标题，添加封面与正文图，检查准确的最终效果并保存到明确账号的草稿箱；重开后继续原进度。成功、失败、等待和需要授权都有明确表达。

按 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 顺序执行。任务 1 未通过真实安装环境的打开验证，不进入页面重构。每项完成后记录验证证据；提交只包含本项文件，不夹带已有 dist 或其他未跟踪文件。

## 文件责任地图

| 区域 | 现有入口 | 调整责任 |
| --- | --- | --- |
| 安装与激活 | `src/index.ts`、`cordis.patch.yml`、`src/creator/runtime.ts` | 第一项根据证据定位，不预设根因 |
| 文章入口 | `src/client/index.ts`、`article-panel-model.ts`、`ArticlePanel.tsx`、`creator-client.ts` | 当前上下文、列表、导入和导航 |
| 创作界面 | `src/client/CreatorWorkspace.tsx`、`ArticlePreview.tsx` | 主文稿、工具与阅读状态 |
| 外观 | `src/client/ArticlePanel.css`、`CreatorWorkspace.css` | DSH 一致性与窄屏布局 |
| 文章与操作 | `src/creator/types.ts`、`remote.ts`、`service.ts`、`session.ts`、`runtime.ts` | 新增动作和现有动作的统一状态 |
| 持久化和交付 | `src/creator/documents.ts`、`delivery.ts`、`revise.ts`、`image-choices.ts` | 保留版本、权限、结果校验 |
| 错误 | `src/creator/errors.ts`、`src/client/creator-client.ts` | 明确且安全的错误分类 |
| 安装验收 | `scripts/creator-host-acceptance/`、`tests/creator/` | 真实宿主、模拟服务和浏览器证据 |

只在下文明确拆出有独立职责的文件，不进行全项目重构。

### Task 1：复现并修复文章打不开

**Files:** 检查上述安装与激活入口、`src/creator/remote.ts`、`src/client/creator-client.ts`；按证据只修改命中根因的文件。扩展 `tests/creator/client-adapter.test.ts`、`document-remote.test.ts`、`scripts/creator-host-acceptance/run.mjs`；新增排障记录 `docs/research/2026-10-21-article-open-root-cause.md`。

**Interfaces:** 保持 `list(agent, signal)`、`open(agent, source, title, signal, options?)` 和 `retainSession(sessionId, signal)` 原契约。未知错误仍保守分类，不通过吞错返回空列表。

- [ ] 在当前实际安装包和运行宿主记录脱敏的 list/open 错误、插件激活状态、连接状态、CLI 可用性及会话就绪顺序；区分启动、鉴权、挂载、文件读取各环节。禁止输出密钥、访问令牌。
- [ ] 使用一个新会话和一个已有会话复现；同目录不等于同权限。将实际失败压缩为可重复测试，记录失败断言与运行命令。
- [ ] 修复已证实原因；不跳过权限、预览检查或 CLI 能力检查。
- [ ] 对错误类型分别验证断连、无权限、文件不存在、文章数据损坏；界面分别给出重连、选择允许文件、重新选择文件、恢复文章的动作，未知原因不伪称权限问题。
- [ ] 运行 `pnpm exec vitest run tests/creator/client-adapter.test.ts tests/creator/document-remote.test.ts tests/contract/plugin-lifecycle.test.ts`，新增根因回归也必须通过。
- [ ] 重新打包、安装、重启并在浏览器打开示例文章；刷新及再次启动后仍可继续同一篇文章。记录截图和原文校验结果，才关闭本任务。

### Task 2：文章入口跟随当前任务，减少管理概念

**Files:** 修改 `src/client/article-panel-model.ts`、`index.ts`、`ArticlePanel.tsx`、`creator-client.ts`；测试 `tests/creator/article-panel.test.ts`、`client-entry.test.ts`、`client-adapter.test.ts`。

**Interfaces:** 保留 `ArticlePanelNavigation`；给 `ArticlePanelClient` 增加 `getCurrentSessionId(): string | undefined`，仅由宿主实际选中会话解析。没有可靠宿主能力时返回 undefined，显示友好的工作位置选择，不能取列表第一项。

- [ ] 增加断言：聊天快捷入口直接打开准确文章；直接点击“文章”优先恢复仍可访问的明确选择，其次当前会话；均无时显示导入引导。
- [ ] 增加断言：会话切换取消旧请求，旧结果不串入；离开释放引用，返回可以恢复。
- [ ] 调整入口为“继续最近文章”“导入文章”；选择会话变为必要时的工作位置选择。没有会话时提供宿主创建会话入口，创建完成后回到导入，不静默扩大权限。
- [ ] 将旧版本恢复、路径输入收进“更多”；保留原功能和旧快捷入口恢复路径。
- [ ] 运行 `pnpm exec vitest run tests/creator/article-panel.test.ts tests/creator/client-entry.test.ts tests/creator/client-adapter.test.ts`，并实际走一遍无会话、当前会话和恢复文章三种入口。

### Task 3：不用填写路径也能导入文章

**Files:** 新建 `src/client/ArticleImport.tsx`、`src/creator/import-source.ts`、`tests/creator/import-source.test.ts`；修改 `ArticlePanel.tsx`、`article-panel-model.ts`、`creator-client.ts`、`src/creator/types.ts`、`remote.ts`、`runtime.ts`。

**Interfaces:** 新增 `ArticleImportRequest = { name: string; markdown: string }`；新增会话鉴权 Remote `importSource(agent: Agent, input: ArticleImportRequest, signal: AbortSignal): Promise<CreatorView>`，通过已有运行时工作区写入能力保存后调用现有 open。浏览器入口封装为 `importSource(sessionId, input, signal): Promise<ArticlePanelArticle>`。已有工作区文件选择使用宿主 list 能力后调用原 open，不通过上传重建原文件。

- [ ] 先写输入测试：UTF-8、中文空格名、空内容、重复名、取消、越界名、只读工作区；空内容报明确错误，取消不写入，重名不覆盖。
- [ ] 工作区内文件用可浏览列表选择；外部 Markdown 文件支持选择和拖入；粘贴正文也走同一导入入口。首版 Markdown 文本上限 2 MiB，前后端一致校验并在超过时明确提示。
- [ ] 导入副本放 `.dsh/md2wechat/imports/<随机标识>/article.md`，文件名仅用于展示，不作为任意写入路径；使用宿主许可的写入能力。
- [ ] 检查相对图片引用：原工作区文件保留原解析位置；外部导入无法访问配图时提示补选图片，不静默删图、不扫描外部目录、不自动下载远端资源。
- [ ] 未排版时展示标为“原文”的安全文本视图，禁止直接执行文章 HTML；正文不被空白引导替代。
- [ ] 运行 `pnpm exec vitest run tests/creator/import-source.test.ts tests/creator/article-panel.test.ts tests/creator/storage-policy.test.ts`；浏览器验证选择、拖入、粘贴各一次，确认副本和源文正确。

### Task 4：正文主区域与官方风格统一

**Files:** 修改 `src/client/ArticlePanel.tsx`、`CreatorWorkspace.tsx`、两份 CSS、`ArticlePreview.tsx`；新建 `src/client/ArticleToolbar.tsx`；扩展 `tests/creator/article-panel.test.ts`、`workspace-ui.test.ts`。

**Interfaces:** `ArticleToolbar` 只控制显示状态：`activeTool: 'style' | 'title' | 'images' | null`、`onToolChange`、`onOpenDelivery`。不直接拥有文章数据或执行 Remote 请求。

- [ ] 增加行为断言：打开文章后列表默认收起；切换工具不丢阅读位置和已选内容；键盘可打开关闭工具并回到触发按钮。
- [ ] 顶部只显示文章标题、保存状态、草稿箱入口和更多菜单；删除重复工作区大标题与常驻解释段落。
- [ ] 主区域显示文章，右侧最多显示一个工具；列表作为返回页或临时面板，不永久占第二个左栏。聊天与工具避免并排叠加为四栏。
- [ ] 使用两种受支持 DSH 版本共有的主题语义值；对没有稳定公共控件的部分保留 React 控件但跟随宿主外观，不导入最新版本独有组件。深浅色都验证。
- [ ] 以文章面板可用宽度判断布局：≥960 px 为正文加 288 px 工具，<960 px 工具按需覆盖或切换；退出工具恢复正文位置。390 px 下无页面水平滚动。
- [ ] 运行 `pnpm exec vitest run tests/creator/article-panel.test.ts tests/creator/workspace-ui.test.ts`；在 1440、1024、768、390 px 和深浅色实际检查主操作、焦点、长标题与正文。

### Task 5：排版可比较，标题可直接修改

**Files:** 新建 `src/client/TitleEditor.tsx`、`src/client/ThemePicker.tsx`；修改 `CreatorWorkspace.tsx`、`src/creator/types.ts`、`service.ts`、`session.ts`、`revise.ts`；扩展 `tests/creator/edits.test.ts`、`revise.test.ts`、`workspace-ui.test.ts`、`delivery.test.ts`。

**Interfaces:** `CreatorAction` 增加 `{ type: 'set-title'; title: string }`；复用现有 `request-suggestions(kind: 'title')`、`apply-suggestion` 和 undo。最终发布标题使用统一来源并与实际预览返回标题核对，不只改界面标签。

- [ ] 写断言：手工标题、候选标题、撤销以及源文自带标题信息时，预览与草稿标题一致；标题变化使旧审阅失效。
- [ ] 标题旁显示“修改”“想几个标题”；最多展示三个候选，没有足够结果不凑假候选；选择后立即反馈且可撤销。
- [ ] 主题提供少量视觉样例与全部主题入口；静态样例明确标为样例，不冒充当前文章真实排版。选择才请求实际预览，不批量发送文章给外部服务生成缩略图。
- [ ] 快速选择只应用最后确认的当前结果；等待保留旧预览并标明旧状态，错误不能恢复为“已审阅”。
- [ ] 运行 `pnpm exec vitest run tests/creator/edits.test.ts tests/creator/revise.test.ts tests/creator/workspace-ui.test.ts tests/creator/delivery.test.ts`；浏览器实测连续切换和失败恢复。

### Task 6：封面与正文图片就地选择

**Files:** 新建 `src/client/ImagePicker.tsx`；修改 `CreatorWorkspace.tsx`、`ArticlePreview.tsx`、`src/creator/import-source.ts`、`types.ts`、`remote.ts`、`runtime.ts`；扩展 `tests/creator/import-image.test.ts`、`image-choices.test.ts`、`image-operations.test.ts`、`workspace-ui.test.ts`。

**Interfaces:** 复用现有 `select-cover`、`place-image(candidateId, anchorId)`、`remove-image`、`request-images`。增加鉴权 `importImageBytes(agent, input: {name:string; contentType:string; data:number[]}, signal): Promise<{sourcePath:string}>`，在会话内存入副本后使用原 `import-local-image` 校验。

- [ ] 测试 PNG/JPEG/GIF/WebP、错误内容、取消和超过 10 MiB 的图片；前后端限制一致，实际内容与格式必须匹配，用户取消不产生候选。
- [ ] 封面区域同时展示“上传图片”“生成封面”；使用当前图、替换和移除可直接完成。确认前展示最终封面效果；首轮不引入完整裁图编辑器。
- [ ] 正文显示受支持段落的上下文和添加图片按钮。优先安全映射预览段落；无法可靠映射的主题使用相邻的正文定位视图，不猜 iframe 节点对应关系，不使用长下拉框。位置必须来自当前 `imagePlacements`。
- [ ] 显示候选、选中态和生成状态；生成时允许浏览与工具切换，避免阻塞整个界面；变更到新版本后旧位置与旧候选不能误应用。
- [ ] 付费与备用上传行为在触发前说明；拒绝授权时保持原图。只上传已选图的正常交付规则保持不变。
- [ ] 运行 `pnpm exec vitest run tests/creator/import-image.test.ts tests/creator/image-choices.test.ts tests/creator/image-operations.test.ts tests/creator/workspace-ui.test.ts`；浏览器完成一张封面和一张正文图的导入、替换、撤销或移除。

### Task 7：连贯的预览与草稿保存流程

**Files:** 新建 `src/client/DraftFlow.tsx`、`draft-flow-model.ts`、`tests/creator/draft-flow-ui.test.ts`；修改 `CreatorWorkspace.tsx`、`src/creator/types.ts`、`delivery.ts`、`service.ts`、`runtime.ts`；扩展 `tests/creator/delivery.test.ts`、`export-draft-operations.test.ts`。

**Interfaces:** `DraftFlow` 消费同一个 `CreatorView` 和 `dispatch`；显示状态为 `checking | needs-input | preparing | reviewing | saving | completed | unknown | error`，由服务结果推导，不凭按钮点击标为成功。`CreatorView` 增加可选的脱敏目标信息 `{ label:string; verified:boolean }`；没有可验证名称时明确“当前配置公众号（名称未验证）”，保存前要求用户核对，不能自造账号信息。

- [ ] 写状态测试：缺封面或配置有补齐入口；拒绝上传不保存；准备完成后审阅的是最终内容；修改标题或图片后必须重新准备/审阅；重复点击不能重复提交。
- [ ] 顶部唯一主动作“保存到公众号草稿箱”，打开同一流程展示账号、标题、封面、摘要（仅现有服务支持时）和文章；“导出 HTML”保留为次要动作，并给默认保存位置。
- [ ] 依次复用 `prepare-delivery` → 最终预览 → `review-current` → `create-draft`，隐藏内部术语但不合并或伪造授权。用户取消在提交前停止，不承诺撤销已发生的上传。
- [ ] 提供具体进度：准备图片、生成最终预览、等待确认、保存草稿；失败保留已完成结果和安全重试入口。
- [ ] 结果未知时继续沿用持久化防重复屏障；仅用户核对后通过既有 reconcile 动作解除。成功信息只来源于已验证返回；无可用链接则提供“前往公众号后台”普通入口，不伪造直达草稿地址。
- [ ] 运行 `pnpm exec vitest run tests/creator/draft-flow-ui.test.ts tests/creator/delivery.test.ts tests/creator/export-draft-operations.test.ts tests/creator/recovery-runtime.test.ts`，并在模拟写入环境核对最终预览、导出及草稿内容一致。

### Task 8：整体验收、安装回归与交付

**Files:** 扩展 `scripts/creator-host-acceptance/run.mjs`、`browser.mjs` 和 README；更新项目 `README.md`；新建 `docs/research/2026-10-21-article-repair-acceptance.md` 保存实际结果。

- [ ] 运行 `pnpm typecheck`、`pnpm lint`、`pnpm run check:boundaries`、`pnpm test`、`pnpm run build`、`pnpm run pack:check`，逐项记录退出状态；失败修复后重跑相关项。
- [ ] 用 `pnpm pack --pack-destination ./dist` 产出唯一待交付包。按 `scripts/creator-host-acceptance/README.md` 同包测试两个宿主与两个 CLI 版本，记录相同包校验值。只用隔离配置，模拟素材上传和草稿写入。
- [ ] 用实际安装页面完成：导入中文文件 → 换主题 → 修改标题 → 上传封面 → 添加正文图 → 专注预览 → 确认模拟草稿 → 重启恢复；使用真实页面而非单独展示组件代替。
- [ ] 浏览器补测断连、取消授权、源文件变化、缺图、只读、窄屏和深色；截图覆盖初次进入、编辑、最终确认、成功及可恢复失败。对安全状态断言可自动化，视觉细节以实际浏览器检查为准。
- [ ] 在已授权的本机安装修复包并重启，复核原用户会话与文章可打开；保留旧包和配置备份用于回退，不删用户文稿或既有进度。
- [ ] 真实排版使用获准内容；真实微信草稿或付费生成需另有明确授权。未获授权则停止该外部动作，报告“模拟流程通过，真实服务待验证”，不得把全链路完成写成事实。
- [ ] 更新文档为真实入口与流程，列明已过检查、未验证范围、回退方式。最终用普通语言汇报，不要求用户代替执行者逐项检查。

## 范围检查

- 修好文章打开：任务 1、2、3、8。
- 正文成为中心并融入 DSH：任务 2、4、5、6。
- 导入到草稿箱完整流程：任务 3、5、6、7、8。
- 保留撤销、源文、恢复、安全确认：贯穿约束及任务 1、5、6、7、8。
- 本轮不做：独立网站、全功能富文本编辑器、多账号管理、完整裁图器、跨会话全文搜索、另造图片生成服务。它们不是三项完成标准的前置条件。

## 当前未决事实与处理方式

文章打开失败根因尚未证实，不能指定一个未经验证的补丁；任务 1 用真实失败决定改动。当前宿主上下文与文件选择能力以两个受支持版本的声明和真实运行结果为准，任务 2、3 的本地适配层吸收差异，不改变权限边界。真实微信账号与费用未授权，最终验收区分模拟和真实，不将其隐去。

## 计划自查

已核对现有文件和测试入口；三项目标均有任务与验收；新动作与数据归属明确；不以纯外观工作替代功能修复；不以虚构根因、虚构账号或模拟成功代替事实。执行时每任务完成后勾选并附证据，当前全部未执行。
