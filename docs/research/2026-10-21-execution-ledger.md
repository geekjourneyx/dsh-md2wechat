# Execution ledger — plan: docs/superpowers/plans/2026-10-21-article-experience-repair.md

Task 1: in progress; browser root cause confirmed missing remote child-service injection. Red: client-entry 1 failed / 3 passed.
Tasks 2–8 pending.
Preflight: 2/3 share client interface; 5/6/7 share version-bound CreatorAction; preserve review invalidation.
Ruling: reuse dependencies with direct tool binaries because pnpm auto-install rejects symlinked modules; no shared dependency purge.
Ruling: normalize temporary test roots on macOS to exercise existing race tests, not weaken assertions.

Task 1: 实际安装页面读取 Number 1 列表并打开 installation-check.md 成功。安装包同名缓存导致首次替换未生效，独立包名后 SHA256 与构建产物一致。
Ruling: 当前受支持宿主的 global main slot 无可靠当前聊天选择，getCurrentSessionId 返回 undefined，保留用户明确选择和工具快捷入口；不猜测列表第一项。

用户纠偏：主流程在当前对话写作 → 文章卡片 → 侧边预览和调整 → 草稿确认；独立入口仅文章历史。覆盖原计划全局工作区主入口设计。宿主 rightbar 已被占用，无公开可追加页签；使用官方 shell.overlay 添加可收起文章阅读层，不替换原侧栏、不切走聊天。新工具直接接受 markdown，由助手传入正文，小白无需路径。
Task 2/3 当前验证29项通过；导入相对图片采用明确拒绝并指向工作区原文件，避免静默丢图。

Ruling（覆盖旧判断）：实际发布的 0.2.1-rc.2 提供 sidebarRight / sidebarRightTabs 与 sidebar.right.pane.tab 公共协议；最新源码反而已变更。改用实际发布版本原生侧栏，删除 shell.overlay 阅读层，避免遮挡对话。对话卡片使用当前会话作用域的 conversation.input.dock，不依赖收起的工具轨迹。

验证：795 项测试通过；官方侧栏真实页面成功打开，对话输入框和文章同时可见。独立审查发现的实际公众号标题展示、32 Unicode 字限制、YAML 多行标题与 $& 转义问题均已修复并补测试。
Ruling: 图片限制沿用后端已有 8 MiB，前后端统一，原计划 10 MiB 不适用。

## 最终收口
采用当前正式安装版本提供的原生右侧标签 API，移除曾试用的覆盖式面板。对话卡片为常驻入口。最终 796 项测试与 32 项隔离检查通过。完整边界见 final-acceptance 文档。
