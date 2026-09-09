# Happy Relay Server for Debian 13 amd64

这是一个离线可安装的 Happy 纯中继服务器包。它只包含 API、Socket.IO、PGlite
数据库、数据库迁移和本地附件存储，不包含 Web App，也不依赖外部 PostgreSQL、
Redis 或 S3。

运行镜像基于 Debian 13 distroless，以固定的非 root UID 启动。镜像有意不包含
shell、npm、Perl、curl 或包管理器；请使用随包提供的 `relayctl.sh` 管理和诊断，
容器内 `docker exec ... sh` 不可用。

## 要求

- Debian 13 x86_64（amd64）
- Docker Engine
- Docker Compose v2（命令为 `docker compose`）
- 使用 root shell 运行安装和管理命令

## 安装

```bash
tar -xzf happy-relay-server-<version>-debian13-amd64.tar.gz
cd happy-relay
./install.sh
```

安装脚本会校验发行包，加载本地镜像，生成 master secret，运行数据库迁移并等待
`/health` 完成真实数据库查询。重复执行 `./install.sh` 会保留原 secret、配置和
`happy-relay_happy-data` 数据卷。

宿主 secret 始终保存在 `root:root 0700` 的 `secrets/` 目录中，文件权限固定为
`root:65532 0440`。Compose 将同一个文件只读挂载给 GID `65532` 的非 root
服务进程；secret 不复制，也不写入 Docker Config 环境或 `.env`。entrypoint 从只读
挂载读取后，仅在服务进程运行期设置 `HANDY_MASTER_SECRET`。安装器和管理脚本会拒绝
符号链接、非普通 secret 文件和多重硬链接，避免 root 命令跟随被替换的路径。

新安装默认仅监听 `127.0.0.1:3005`，并始终使用 Codex Sync v4。常用管理命令：

```bash
./relayctl.sh status
./relayctl.sh health
./relayctl.sh storage-health
./relayctl.sh logs --tail 100
./relayctl.sh restart
```

## 数据库维护与容量

Relay 默认在唯一的 PGlite 实例中运行普通 VACUUM，每次完成后等待至少一分钟再维护
下一张表；Account、Session 每十分钟优先维护，其余表轮转，每小时独立 CHECKPOINT。
普通 VACUUM 让旧行空间可复用，不保证文件立即缩小；例行维护不会重启服务、执行
VACUUM FULL 或删除有效数据、数据库文件和 WAL。

`./relayctl.sh storage-health` 读取 `/data/pglite-maintenance.json` 的最新原子快照，
输出容量、维护进度和告警。它不打开第二个 PGlite 实例。退出码：`0` 健康、`1` 告警、
`2` 严重容量问题或快照缺失、损坏、不支持、超过三分钟未更新。首次启动约一分钟生成快照。

- 可用空间不足 20% 或 5 GiB 告警，不足 10% 或 2 GiB 为严重告警。
- 单表总量包含 heap、TOAST 和索引，超过 256 MiB 时跳过并告警；需要人工评估。
- SQL 失败、热表三十分钟或普通表两小时无成功、维护总耗时超过两秒都会告警。
  慢表或连续失败三次的表每小时重试，其他表继续轮转。两秒是观测阈值，不是 SQL 取消期限。
- 每小时关系或 WAL 增长超过 `max(256 MiB, 上次大小的 25%)` 提示检查，首次无对比样本为未知。

出现告警时先对照新消息/附件量、表实际大小、最近成功和失败信息。WAL 保留供复用、
估计废弃行数为零均不能独立证明没有膨胀；不要删除 WAL 或用数据清空处理容量问题。
超限或持续失败应安排明确的维护方案。维护影响请求时，可在 `.env` 设置
`PGLITE_MAINTENANCE_ENABLED=false` 后运行 `./relayctl.sh start` 临时停用；状态持续告警，
恢复为 `true` 后同样运行 `start`。该开关不会停用容量采样，也不会阻止正常业务写入。

## 局域网 HTTP

需要让原生 App 或 CLI 从可信局域网访问时，编辑 `.env`：

```dotenv
HAPPY_RELAY_BIND_ADDRESS=0.0.0.0
HAPPY_RELAY_PUBLIC_URL=http://192.168.1.20:3005
```

然后运行 `./relayctl.sh start`。应同时使用主机防火墙限制来源。HTTP 模式仅适合
可信网络；主动 MITM 下不承诺 token、ACK、服务端身份、元数据或零丢失。Web
客户端仍只允许 HTTPS 或 localhost，不能通过普通局域网 HTTP 使用本中继。

## 升级与备份

升级时把新包解压到现有安装目录，再执行 `./install.sh`。如果必须更换目录，先把
旧目录的 `.env` 和 `secrets/master-secret` 一并迁移。只复用 Docker volume 而
丢失 master secret 会导致安装器拒绝启动，避免静默破坏现有身份。

备份时应一起保存：

- Docker named volume `happy-relay_happy-data`
- `secrets/master-secret`
- `.env`

`./relayctl.sh stop` 只停止容器，不删除数据。发行脚本不包含 `down -v`、重置
secret 或清空数据库操作。
