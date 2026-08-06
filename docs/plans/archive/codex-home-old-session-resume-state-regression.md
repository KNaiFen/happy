# Codex 首页旧会话恢复与状态回归修复计划

## 状态

- 当前状态：已解决；实现、源码级验证与完整 monorepo CI 已通过。
- 归档日期：2026-08-06。
- 范围：App 首页/详情恢复交互、CLI daemon/Gateway 恢复协调、非活跃会话状态展示。
- 不改变 Relay Sync v4 真值边界，不用超时或 transport loss 推断执行终态。

## 已核验证据

- 首页使用 `resume-happy-session` 直接恢复已存 `codexThreadId`；设备页先调用
  `codex-list-threads`、扫描绑定，再通过 `CodexThreadOpenCoordinator` 打开线程。
- 失败请求已经到达官方 `thread/resume`，但 Gateway control 把 handler 异常统一改写为
  `invalidRequest` 400，App 信息页也未呈现 hook 已保存的 `resumeError`。
- `/root/open` 失败路径没有停止刚创建且尚未绑定 root 的 Gateway。
- 非活跃会话仍可能保留 activated projection，详情页优先显示其旧 Gateway phase。

## 完成内容

- [x] 让首页恢复复用设备页的线程核验、绑定校验和 Gateway 协调逻辑。
- [x] 返回 payload-free 的 typed resume result，区分线程不存在、外部占用、正在恢复、
      绑定无效、操作失败和结果未知。
- [x] 区分 Gateway control 输入错误与操作错误；明确失败时清理新建未绑定 Gateway，
      超时先对账后处置。
- [x] App 根据机器 `resumeSupport.rpcAvailable` 决定按钮能力，并显示 loading、错误与重试。
- [x] 线程确实不存在时提供进入设备线程列表的入口，不创建替代会话。
- [x] 非活跃或归档会话只显示历史状态和最后活跃时间。
- [x] 增加 App/CLI 定向测试、现场复现和云端 CI 证据。

## 验收标准

- 可用旧线程从首页恢复同一个 Happy session；设备页恢复无回归。
- 不可用线程给出明确、可操作且已本地化的提示，不启动空闲 Gateway。
- 明确失败后不存在新产生的 `running/headless current:null` Gateway。
- 非活跃会话不再显示瞬时 Gateway 状态或附加“未知”。

## 验证证据

- 实现提交：`796e3e4b2e4fec99044a9ae55fd0f9540eece060`；旧断言改为验证稳定阻塞分类的
  测试提交：`9a271b6f2b3c870113e0a15adcd6acfb44428423`。
- CLI：类型检查通过；恢复、线程协调、Gateway control/launcher/worker 等定向测试
  70 项通过；跳过本地构建的全量 unit 为 101 个文件、945 项全部通过。
- App：类型检查通过；恢复操作、队列回归与 Gateway UI 状态 3 个文件、20 项测试通过；
  10 个语言文件均为 844 个键且键集合一致。
- 云端：monorepo CI run
  [`31060623946`](https://github.com/KNaiFen/happy/actions/runs/31060623946) 成功；包含 CLI、
  App、Server、Wire、稳定 v2 协议、官方 Codex app-server 生命周期、真实 PTY 11 分钟空闲后
  重附着与正常停止，以及最终 Required gate。
- 阶段版本：Android App `1.11.30`，CLI `1.4.43`。最终安装候选的首页现场复核随统一发布验收执行。
