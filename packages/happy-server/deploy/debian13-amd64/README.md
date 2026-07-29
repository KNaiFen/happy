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
- 当前用户有权访问 Docker daemon

## 安装

```bash
tar -xzf happy-relay-server-<version>-debian13-amd64.tar.gz
cd happy-relay
./install.sh
```

安装脚本会校验发行包，加载本地镜像，生成 master secret，运行数据库迁移并等待
`/health` 完成真实数据库查询。重复执行 `./install.sh` 会保留原 secret、配置和
`happy-relay_happy-data` 数据卷。

宿主 secret 始终保存在权限为 `0700` 的 `secrets/` 目录和 `0600` 文件中。
`install.sh`/`relayctl.sh` 仅在调用 Compose 的子进程中短暂提供 secret 来源，
容器内以 UID/GID `65532`、模式 `0400` 只读挂载，不进入容器环境或 `.env`。

新安装默认仅监听 `127.0.0.1:3005`，Codex Sync v4 默认关闭。常用管理命令：

```bash
./relayctl.sh status
./relayctl.sh health
./relayctl.sh logs --tail 100
./relayctl.sh restart
./relayctl.sh enable-v4
```

仅在匹配版本的 App/CLI 已安装、且没有旧版 Codex turn 运行时执行
`enable-v4`。脚本不会删除数据库卷，也不会自动重新生成已有 secret。

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
