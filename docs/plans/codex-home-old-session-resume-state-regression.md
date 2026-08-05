# Codex 首页旧会话恢复与状态回归修复计划

## 状态

- 当前状态：待修复；由 Relay `1.1.40` 现场升级验收发现，优先级 P1 高。
- 范围：App 首页/详情恢复交互、CLI daemon/Gateway 恢复协调、非活跃会话状态展示。
- 不改变 Relay Sync v4 真值边界，不用超时或 transport loss 推断执行终态。

## 已核验证据

- 首页使用 `resume-happy-session` 直接恢复已存 `codexThreadId`；设备页先调用
  `codex-list-threads`、扫描绑定，再通过 `CodexThreadOpenCoordinator` 打开线程。
- 失败请求已经到达官方 `thread/resume`，但 Gateway control 把 handler 异常统一改写为
  `invalidRequest` 400，App 信息页也未呈现 hook 已保存的 `resumeError`。
- `/root/open` 失败路径没有停止刚创建且尚未绑定 root 的 Gateway。
- 非活跃会话仍可能保留 activated projection，详情页优先显示其旧 Gateway phase。

## 待完成

- [ ] 让首页恢复复用设备页的线程核验、绑定校验和 Gateway 协调逻辑。
- [ ] 返回 payload-free 的 typed resume result，区分线程不存在、外部占用、正在恢复、
      绑定无效、操作失败和结果未知。
- [ ] 区分 Gateway control 输入错误与操作错误；明确失败时清理新建未绑定 Gateway，
      超时先对账后处置。
- [ ] App 根据机器 `resumeSupport.rpcAvailable` 决定按钮能力，并显示 loading、错误与重试。
- [ ] 线程确实不存在时提供进入设备线程列表的入口，不创建替代会话。
- [ ] 非活跃或归档会话只显示历史状态和最后活跃时间。
- [ ] 增加 App/CLI 定向测试、现场复现和云端 CI 证据。

## 验收标准

- 可用旧线程从首页恢复同一个 Happy session；设备页恢复无回归。
- 不可用线程给出明确、可操作且已本地化的提示，不启动空闲 Gateway。
- 明确失败后不存在新产生的 `running/headless current:null` Gateway。
- 非活跃会话不再显示瞬时 Gateway 状态或附加“未知”。
