# Happy Server 包安装与解析契约修复计划

## 状态

- 当前状态：进行中（归档 runtime 云端 smoke 已通过；全局同级包解析仍等待可分发实现决策）。
- 建立日期：2026-08-10。
- 发现基线：PR [#28](https://github.com/KNaiFen/happy/pull/28) 的 CLI Smoke run [31335259939](https://github.com/KNaiFen/happy/actions/runs/31335259939)。
- 负责范围：`packages/happy-cli/src/commands/server.ts`、`happy-server-self-host` 安装说明与 CLI package smoke。
- 版本边界：修复 CLI 解析行为时必须提升 `packages/happy-cli/package.json` 的 patch version；本次 CI 编排 PR 不改变包版本。

## 已确认事实

存在两个相互独立的缺口：

1. `happy server` 使用 CLI 安装目录中的 `createRequire(import.meta.url)` 加载
   `happy-server-self-host`。普通 `npm install -g happy happy-server-self-host` 会把两个包安装为全局
   `node_modules` 下的同级目录；Node 不会从 `happy` 的依赖解析链自动搜索该同级包。
2. CLI Smoke 原先只执行 Prisma generate 和 Web bundle 就 pack Server，归档没有
   `dist/standalone.mjs`。Server 的 `index.cjs` 因此返回 `undefined`，即使把三个归档安装到同一临时项目也无法启动。

CLI 当前的失败提示仍建议执行 `npm install -g happy-server-self-host`。旧 CLI Smoke 同时保留了仓库 checkout，包解析失败或归档缺少 runtime 后都会命中
`packages/happy-server/sources/standalone.ts` 源码 fallback，因此绿色结果没有证明已安装的 server 包可被 CLI 找到。PR #28 将构建与运行矩阵分离后移除了 checkout，Linux Node 24 job
[93300313347](https://github.com/KNaiFen/happy/actions/runs/31335259939/job/93300313347) 暴露了全局解析问题；随后同一 PR 的隔离安装 job
[93301340604](https://github.com/KNaiFen/happy/actions/runs/31335692694/job/93301340604) 在补齐同地安装后确认归档 runtime 缺失。

阶段 1 的 Actions 修复会保留两条不互相冒充的 smoke：

- 全局安装 `happy-wire` 与 `happy`，验证 CLI 命令；
- 在没有源码 checkout 的临时项目中同地安装三份 tgz，验证 packaged server、PGlite/Prisma 和 `happy server` 集成。

当前 Actions 实现已在 prepare job 安装 Bun，执行 `build:runtime` 后再 pack；这只修复 smoke 输入的真实性，不改变已发布包。

这能阻止源码 fallback 再次掩盖归档缺陷，但不会把全局同级安装错误标记为已修复。

PR [#28](https://github.com/KNaiFen/happy/pull/28) 的最终 CLI Smoke
[31336163603](https://github.com/KNaiFen/happy/actions/runs/31336163603) 已证明 prepare 生成的
Server tgz 包含可加载的 standalone runtime；Linux Node 20/24 在没有源码 checkout 的临时项目中
同地安装三份 tgz 后均通过 PGlite/Prisma 与 `happy server` 集成检查。该证据只关闭“归档缺少
runtime”这一 smoke 输入缺口，不证明 `npm install -g happy happy-server-self-host` 的全局同级布局
能够被当前 CLI resolver 找到。

## 下一步

1. 为 server artifact resolver 增加隔离测试，覆盖全局同级安装、项目本地同地安装和仓库源码 fallback，明确每种布局的优先级。
2. 在以下方案中选择并实现一个可维护契约：显式解析当前 npm global root，或把 server 作为 CLI 可解析的正式依赖/安装布局；不得依赖 `NODE_PATH` 等用户隐式环境。
3. 保持 release/package workflow 在 pack 前生成 `dist/standalone.mjs`，并对归档内容做独立断言。
4. 同步 CLI 错误提示、安装文档和 package smoke，只保留实际支持的命令。
5. 提升 CLI patch version，走 CLI package workflow，并从干净 runner 下载同一归档复验。

## 验收标准

- 从空环境执行文档声明的安装命令后，`happy server` 不依赖仓库 checkout 或源码 fallback 即可找到 `happy-server-self-host`。
- Server tgz 含 `dist/standalone.mjs`、Web bundle 和 Prisma 所需运行时输入，`index.cjs` 返回有效 artifact。
- 启动后的根端点可用，`/v1/auth/request/status` 返回结构化状态，日志中没有 Prisma query engine 初始化错误。
- Linux Node 20/24 的全局或明确替代安装契约都有云端 smoke；Windows 继续验证 CLI 命令，不虚构未实现的 Server 平台支持。
- CLI 错误提示、README、活动计划和实际包解析顺序一致，并附精确 commit、package workflow 和 artifact 证据。
