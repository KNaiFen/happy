# 发行矩阵

> 此文件由 `node scripts/docs/knowledge-base.mjs --write` 生成。不要手工编辑。版本来自各包的 `package.json`。

| 可分发包 | 当前版本 | 云端工作流 | 产物 | 触发条件 |
| --- | ---: | --- | --- | --- |
| `happy` | `1.4.54` | [CLI package](../.github/workflows/build-cli-release.yml) | `happy-1.4.54.tgz` | `packages/happy-cli/package.json` 版本变更 |
| `happy-app`（Android） | `1.11.55` | [Android APK](../.github/workflows/build-android-release.yml) | `happy-app-1.11.55-android-arm64-v8a-no-ota.apk` | `packages/happy-app/package.json` 版本变更 |
| `happy-server-self-host`（Debian Relay） | `1.1.46` | [Debian 13 relay](../.github/workflows/build-debian13-relay-release.yml) | `happy-relay-server-1.1.46-debian13-amd64.tar.gz` | `packages/happy-server/package.json` 版本变更 |
| `happy-agent` | `0.1.11` | [happy-agent package](../.github/workflows/build-happy-agent-release.yml) | `happy-agent-0.1.11.tgz` | `packages/happy-agent/package.json` 版本变更 |
| `@slopus/happy-wire` | `0.1.8` | 由消费者工作流构建和校验 | 共享内部依赖，不单独发布 | Wire 或消费者变更 |

所有包的发布构建仅在 GitHub Actions 运行；本地例行验证保持源码级。完整流程见 [发布知识](knowledge-base.md#发布与制品)。
