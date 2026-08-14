# API

> `/v1` 与 `/v2` 提供账户、设备、目录和兼容数据面；Codex 的规范同步接口位于
> `/v4`。Socket.IO 事件不能替代 v4 change/snapshot 恢复。

This document covers the HTTP API surface and authentication flows. For WebSocket updates and event payloads, see `protocol.md`. For encryption boundaries and encoding details, see `encryption.md`.

## Method conventions
- **GET** is used for reads.
- **POST** is used for mutations or actions, even when the operation doesn't map cleanly to a single entity.
- **DELETE** is used when intent is unambiguous (e.g., removing a token or deleting a session/artifact).

We intentionally avoid the full REST verb palette because many operations span multiple entities or have non-CRUD semantics.

## Authentication
Most endpoints require `Authorization: Bearer <token>`.

Auth flows:
- `POST /v1/auth`
  - Body: `{ publicKey, challenge, signature }` (base64 strings)
  - Verifies signature using the provided public key.
  - Creates or updates the account identified by the public key and returns `{ success, token }` while that account is active.
    A deletion-in-progress account receives HTTP 410. After physical deletion, the same public key can create only a new empty
    account; it does not restore the deleted Account ID, token, auth requests, or data.

- `POST /v1/auth/request`
  - Body: `{ publicKey, supportsV2? }`
  - Creates or returns a terminal auth request.
  - Response: `{ state: "requested" }` or `{ state: "authorized", token, response }`.

- `GET /v1/auth/request/status?publicKey=...`
  - Response: `{ status: "not_found" | "pending" | "authorized", supportsV2 }`.

- `POST /v1/auth/response`
  - Body: `{ response, publicKey }` (requires Bearer auth)
  - Approves a terminal auth request.

- `POST /v1/auth/account/request`
  - Body: `{ publicKey }`
  - Similar to terminal auth, but for account linking.

- `POST /v1/auth/account/response`
  - Body: `{ response, publicKey }` (requires Bearer auth)

## Endpoint catalog
### Sessions
- `GET /v1/sessions`
- `GET /v2/sessions/active?limit=...`
- `GET /v2/sessions?cursor=cursor_v1_<id>&limit=...&changedSince=...`
- `POST /v1/sessions` (create or load by `tag`)
- `GET /v1/sessions/:sessionId/messages`
- `POST /v1/sessions/:sessionId/push-event`
- `DELETE /v1/sessions/:sessionId`

### Codex Sync v4
- `GET /v4/capabilities`
- `POST /v4/sessions/:sessionId/mutations`
- `GET /v4/sessions/:sessionId/changes?after_seq=...`
- `GET /v4/sessions/:sessionId/snapshot`
- `POST /v4/sessions/:sessionId/presence/claim`
- `POST /v4/sessions/:sessionId/presence/touch`
- `POST /v4/sessions/:sessionId/presence/release`
- `POST /v4/sessions/:sessionId/archive`
- `POST /v4/sessions/:sessionId/unarchive`

Mutation, changes, and snapshot routes require a compatible `X-Happy-Client`
header. Unsupported clients receive HTTP 426 and must upgrade rather than
falling back to a legacy Codex protocol.

### Attachments
- `POST /v1/sessions/:sessionId/attachments/request-upload`
- `PUT /v1/sessions/:sessionId/attachments/:attachmentFile`
- `POST /v1/sessions/:sessionId/attachments/request-download`
- `GET /v1/sessions/:sessionId/attachments/:attachmentFile`

Current Servers return an authenticated Server `PUT`/`GET` URL with
`requiresAuth: true`; they proxy both local and S3-compatible storage and do
not issue new direct object-storage capabilities. Clients must send the bearer
token only to their configured Happy Server origin, not to a host supplied by a
proxy-derived URL. Older self-hosted Servers can retain their legacy upload
protocol until upgraded.

### Machines
- `POST /v1/machines` (create or load by id)
- `GET /v1/machines`
- `GET /v1/machines/:id`
- `DELETE /v1/machines/:id`

### Artifacts
- `GET /v1/artifacts?limit=1..100&cursor=<opaque>`
- `GET /v1/artifacts/:id`
- `POST /v1/artifacts`
- `POST /v1/artifacts/:id` (versioned update)
- `DELETE /v1/artifacts/:id`

Successful REST and Socket create, update, and delete operations allocate a
user-scoped `updateSeq` and increment `Account.artifactRevision` in the same
account-write transaction. The response and emitted update envelope carry that
same authoritative sequence; an idempotent duplicate create returns the stored
row without allocating either counter or emitting another event.

The list endpoint returns `{ artifacts, highWatermark, nextCursor }`. Its signed,
account-bound cursor fixes both `highWatermark = Account.seq` and the current
artifact-only revision. Rows are ordered by id and satisfy
`Artifact.updateSeq <= highWatermark`. Unrelated account mutations may advance
`Account.seq` without invalidating continuation; any artifact mutation advances
the artifact revision, so a continued stale snapshot returns `409 Artifact
snapshot changed` and clients restart from the first page. Clients must collect
every page before reconciling absence. At commit, a complete snapshot may remove
local artifacts missing at the watermark, but a lifecycle event newer than the
watermark wins. Delete tombstones reject older updates and delayed fetch
continuations; only a later `new-artifact` envelope with a greater `updateSeq`
can recreate that id.

### Access keys
- `GET /v1/access-keys/:sessionId/:machineId`
- `POST /v1/access-keys/:sessionId/:machineId`
- `PUT /v1/access-keys/:sessionId/:machineId`

### Key-value store
- `GET /v1/kv/:key`
- `GET /v1/kv?prefix=...&limit=...`
- `POST /v1/kv/bulk`
- `POST /v1/kv` (batch mutate)

### Account and usage
- `POST /v1/account/deletion-challenge` (account credential only)
- `DELETE /v1/account` (account credential only)
- `GET /v1/account/profile`
- `GET /v1/account/settings`
- `POST /v1/account/settings`
- `POST /v1/usage/query`

Account deletion is a two-step, irreversible operation. The challenge endpoint
returns a short-lived, server-generated `{ challengeId, challenge, expiresAt }`.
The client signs the challenge with the key derived from its account secret and
submits `{ challengeId, challenge, publicKey, signature }` to `DELETE
/v1/account`. Terminal or machine credentials are rejected. A completed request
returns `200 { status: "deleted" }`; durable object cleanup that is still pending
returns `202 { status: "pending" }` after access has already been disabled.
On a Server error, timeout, or lost response after the proof has been submitted,
clients must treat the request as uncertain and clear local authentication
rather than claim the account remains usable. If the challenge request returns
`409`, another device has already committed the account to deletion; the client
must complete local revocation before reporting `pending`. Deterministic `401`
or `403` challenge rejections occur before proof creation and do not themselves
revoke local state.

### Push tokens
- `POST /v1/push-tokens`
- `DELETE /v1/push-tokens/:token`
- `GET /v1/push-tokens`

Normal sign-out may make one best-effort token DELETE after durable local
revocation. It does not retry that old-credential request in the background.
Account deletion never sends this follow-up because the Server-side deletion
request already owns push-token cleanup.

### Connect (GitHub + vendor tokens)
- `GET /v1/connect/github/params` - 在同一 Serializable 事务中取得账户写入准入、生成绑定
  `{ purpose, admissionId }` 的五分钟 state 并持久化 OAuth admission；只有事务成功后才返回 state。
  删除已开始时返回 `409`，不会向客户端签发 state。
- `GET /v1/connect/github/callback` - state 只能原子 claim 一次；claim 失败或重放不会交换 code、读取
  profile 或上传头像。已 claim callback 必须通过 `completedAt` 持久结算；token POST 的传输或解析结果
  未知时保持 fail-closed，并阻止账户删除完成，不能仅凭 state TTL 自动释放。
- `POST /v1/connect/github/webhook`
- `DELETE /v1/connect/github`
- `POST /v1/connect/:vendor/register` (`vendor` is `openai`)
- `GET /v1/connect/:vendor/token`
- `DELETE /v1/connect/:vendor`
- `GET /v1/connect/tokens`

### Users, friends, feed
- `GET /v1/user/:id`
- `GET /v1/user/search?query=...`
- `POST /v1/friends/add`
- `POST /v1/friends/remove`
- `GET /v1/friends`
- `GET /v1/feed`

### Version and voice
- `POST /v1/version`
- `POST /v1/voice/conversations`
- `GET /v1/voice/usage`

### Dev-only
- `POST /logs-combined-from-cli-and-mobile-for-simple-ai-debugging` (only if enabled)

## Implementation references
- API routes: `packages/happy-server/sources/app/api/routes`
- Auth module: `packages/happy-server/sources/app/auth/auth.ts`
