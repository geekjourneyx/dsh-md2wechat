# 文章打开根因

实际浏览器错误：cannot get property remote.md2wechat without inject。服务端 list 在已有和空白会话均正常返回。客户端仅注入 remote 根服务，动态挂载后的 remote.md2wechat 子服务未声明依赖；workspaceFiles 同样存在隐患。

修复：挂载完成后通过 Cordis 子作用域声明两个命名空间，再注册文章界面。禁止绕过依赖约束。新增客户端入口回归已先失败；随后验证通过才算修复。

基线：778/782 测试通过。4 项失败是 macOS /var 与 /private/var 指向同一临时目录，但测试钩子比较未规范化路径，三项竞争变更钩子未触发，另一个列表路径断言不同。将测试根目录 realpath 后保持原断言，不放宽产品校验。
