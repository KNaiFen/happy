# Multi-process happy-server

How handy-server runs across multiple Kubernetes replicas: socket distribution,
room-based RPC routing, broadcast fan-out, daemon lifecycle, and what happens
during the messy cases (pod kill, brief reconnect, network partition).

For the shorter high-level control-flow doc, see `realtime-sync-and-rpc.md`.

> **Status:** `packages/happy-server/deploy/handy.yaml` ships `replicas: 3`.
> This document describes the current Redis Streams and room-routing behavior;
> the older reproduction history remains in the linked postmortem.

## TL;DR

handy-server uses the **Socket.IO Redis streams adapter** to forward
`io.to(...).emit(...)` between replicas through a single Redis stream. RPC
routing (web → daemon) goes through **Socket.IO rooms** named
`rpc:<userId>:<method>`. The server resolves the daemon socket via
`io.in(room).fetchSockets()` (the cluster-adapter primitive that works
cross-replica), and sends the request to a single RemoteSocket. There is **no
Redis key, no TTL, no Lua-CAS cleanup, no keep-alive refresh path** —
membership is standard Socket.IO room state, cleaned up automatically on
disconnect.

If the daemon is briefly offline at call time (k8s pod cycling, transient
network drop), the server waits up to **15 seconds** for it to reappear. Lookup
attempts use 2 s, 4 s, then 8 s adapter timeouts with a 200 ms gap. If the
daemon disappears during an RPC, a 2 s presence poll requires two consecutive
absent results before failing, normally avoiding the full 30 s emit-with-ack
timeout while tolerating a transient adapter miss.

`connectionStateRecovery` is **commented out** in `socket.ts`. The streams
adapter supports it (verified working) but we ship parity with the
pre-multi-process behavior first; clients still do a full REST re-fetch on
every reconnect via `apiSocket.onReconnected`.

## What an rpc-call does (control flow)

```
rpc-call from web client
.
├── input validation
│   └── method name → invalid → callback({ok:false, error:'Invalid parameters'})
│
├── 1. resolve target via cluster adapter
│   └── fetchRoomSockets(io, 'rpc:<userId>:<method>')
│       ├── io.in(room).timeout(500ms).fetchSockets()
│       ├── on success → returns [...]
│       └── on failure (peer replica unresponsive, fast adapter timeout)
│           └── log + return [] (treat as "nobody here")
│       │
│       ├── returns [target] → go to step 2
│       └── returns []      → go to wait-for-reconnect
│
├── wait-for-reconnect grace (only when no target found)
│   └── waitForRoomMember(io, room, 15_000ms)
│       └── poll via fetchRoomSockets with 2s/4s/8s timeouts and 200ms gaps:
│           ├── room gained a member → return [target]
│           └── deadline reached     → return []
│       │
│       ├── grace produced [target] → go to step 2
│       └── grace produced []
│           └── callback({ok:false, error:'RPC method not available'})
│
├── 2. sanity checks on resolved target
│   ├── multiple sockets in room → log warn, use first
│   └── target.id === socket.id  → callback({ok:false, error:'same socket'})
│
├── 3. fire emit + race a presence poll
│   ├── ackPromise = target.timeout(30_000).emitWithAck('rpc-request', ...)
│   │   (cluster adapter routes cross-replica via Redis stream)
│   │
│   └── presencePoll = while (alive)
│       └── sleep 2s, fetchRoomSockets again (500ms adapter timeout)
│           ├── target still in room → reset the miss count and keep watching
│           └── two consecutive absent results → throw 'RPC target disconnected'
│
├── Promise.race(ackPromise, presencePoll)
│   ├── ackPromise resolves → callback({ok:true, result})
│   ├── ackPromise throws (timeout / err) → callback({ok:false, error: msg})
│   └── presencePoll throws → callback({ok:false, error:'RPC target disconnected'})
│
└── finally
    └── presenceAlive = false  (stops the poll cleanly on success or failure)
```

## What a daemon does (lifecycle)

```
daemon (machine-scoped or session-scoped)
.
├── connect to handy-server
│   └── server: socket.handshake.auth.token → auth.verifyToken
│       └── attaches rpcHandler / *UpdateHandler / etc
│
├── emit('rpc-register', { method })
│   └── server: socket.join('rpc:<userId>:<method>')
│       └── ack: emit('rpc-registered', { method })
│       (Socket.IO room state, NO Redis key, NO TTL)
│
├── on('rpc-request', (data, cb) => …)
│   └── handler runs, cb(result) returns the value via the cluster adapter
│
├── disconnect (any reason)
│   └── Socket.IO automatically removes the socket from all rooms
│       (cluster adapter syncs via heartbeat; no manual cleanup needed)
│
└── auto-reconnect
    └── on 'connect': re-emit rpc-register
        (the only client-side responsibility)
```

## What a broadcast does (event emission)

```
eventRouter.emitUpdate / emitEphemeral
.
└── io.to(rooms).emit('update' | 'ephemeral', payload)
    ├── streams adapter: XADD on the 'socket.io' Redis stream
    │   (MAXLEN ~ 200000, auto-trimmed by Redis)
    └── every replica's XREAD loop picks up the entry
        └── delivers to its local sockets that match the room set
            (sockets that disconnected before the emit miss it; client
             falls through to apiSocket onReconnected → REST refetch)
```

Rooms used by `eventRouter`:

```
.
├── user:<userId>                              all of a user's sockets
├── user:<userId>:user-scoped                  only the web/desktop clients
├── user:<userId>:session:<sessionId>          session-scoped subscribers
└── user:<userId>:machine:<machineId>          one specific machine
```

## Where the code lives

```
.
├── packages/happy-server/sources/app/
│   ├── api/socket.ts                      io.Server setup, attaches the
│   │                                       streams adapter when REDIS_URL
│   │                                       is set, commented-out
│   │                                       connectionStateRecovery
│   ├── api/socket/rpcHandler.ts           the entire RPC routing layer
│   │                                       (~180 lines, single code path)
│   ├── api/socket/machineUpdateHandler.ts no longer touches RPC state
│   ├── api/socket/sessionUpdateHandler.ts no longer touches RPC state
│   └── events/eventRouter.ts              broadcast emission via rooms
│
└── packages/happy-server/deploy/handy.yaml  k8s Deployment + Service
                                             (replicas: 3)
```

## What was wrong before (the four bugs)

The previous attempt stored RPC routing state as `rpc:user:<u>:method:<m>` →
socketId Redis keys with a 60-second TTL refreshed by `machine-alive` /
`session-alive` heartbeats. This had three killer bugs (smoking gun was #3):

```
.
├── #1  In-flight RPC eats the full 30s timeout when the target pod dies
│       io.to(deadSocketId).emitWithAck() has no fast-fail.
│       FIX: presence poll aborts after two 2s checks instead of waiting 30s
│
├── #2  Reconnect race
│       Between the daemon's disconnect cleanup and re-register, ~5–7% of
│       cross-pod RPCs fail with either "method not available" (key
│       deleted) or "target not reachable" (key still pointed at dead
│       socketId).
│       FIX: atomic socket.join / auto-leave on disconnect, no race window
│
├── #3  Silent TTL expiry
│       Daemon stays connected, registration vanishes after 60s if the
│       keep-alive event was missed for any reason. Daemon never knows;
│       stays broken until reconnect.
│       FIX: no TTL exists anymore
│
└── #4  Streams adapter "unbounded growth"
        FALSE ALARM. The adapter trims with MAXLEN ~ on every XADD. Capped
        at ~200k entries. Crossing this off the list.
```

The historical postmortem is at
[`packages/happy-server/deploy/integration-tests/POSTMORTEM.md`](../packages/happy-server/deploy/integration-tests/POSTMORTEM.md).
It records an earlier reproduction and is not the current operational guide.

## How we tested it

The current minikube harness is
`packages/happy-server/deploy/integration-tests/`. Start from that directory:

```bash
bash local.sh
./run-all.sh
```

`run-all.sh` uses a NodePort `minikube service` tunnel when available, so its
normal route survives pod kills. Its default suite runs `stress-prod-realistic.mjs`,
the eight current `stress-rpc-registration.mjs` scenarios (including the
destructive `rolling-deploy` scenario), and `test-rpc-dead-daemon.mjs`. Use
`./run-all.sh --safe-only` to skip `rolling-deploy` and the dead-daemon test, or
`./run-all.sh --deploy` to provision before the suite. A plain
`kubectl port-forward` is a fallback only and is not suitable for pod-kill cases.

The current scenario names are `fire-and-forget`, `register-race-timing`,
`reconnect-no-ack`, `rapid-sessions`, `rolling-deploy`, `ios-session-flow`,
`high-concurrency`, and `cross-replica-3pod`. Historical command names and
measurements in the postmortem must not be used as current acceptance evidence.

## Tunable constants

```
RPC_RECONNECT_GRACE_MS        15_000   wait-for-reconnect window
RPC_RECONNECT_POLL_MS            200   gap between lookup attempts
RPC_LOOKUP_FETCH_TIMEOUTS_MS  2k/4k/8k adapter timeouts during lookup
RPC_PRESENCE_POLL_MS           2_000   in-flight presence-poll cadence
RPC_PRESENCE_FETCH_TIMEOUT_MS    500   per-call cross-replica fetchSockets cap
RPC_CALL_TIMEOUT_MS           30_000   upper bound on emitWithAck
```

## Adapter details and limits worth knowing

```
.
├── streams adapter discovery
│   ~5s after a pod starts, the adapter's heartbeat exchange means
│   cross-replica fetchSockets() may not see all rooms. First few RPCs
│   immediately after a fresh rollout can hit the wait-for-reconnect
│   grace; the current 15s window allows the increasing lookup timeouts to
│   settle without a tight retry loop.
│
├── MAXLEN ~ 200000
│   configured in socket.ts. Auto-trims on every XADD, no cleanup needed.
│
├── fetchSockets() cross-replica
│   defaults to a 5-second timeout per request. We pass timeout(500) for
│   our presence polls so a single unresponsive replica doesn't stall
│   every poll for 5s.
│
├── emitWithAck from a RemoteSocket
│   works cross-replica through the cluster adapter (the streams adapter
│   inherits ClusterAdapterWithHeartbeat which implements BROADCAST_ACK
│   and FETCH_SOCKETS_RESPONSE).
│
└── multiple sockets in the same RPC room
    shouldn't happen in practice (one daemon per machine, one method
    registration). If it does, we log a warn and pick targets[0]. Same
    blast radius as the previous Redis last-write-wins behavior.
```

## What we still don't do (intentional, deferred)

```
.
├── connectionStateRecovery
│   Commented out in socket.ts. Enabling it would let brief disconnects
│   skip the heavy REST refetch (events replay through the streams
│   adapter via restoreSession). Verified working — not shipped to
│   preserve parity with main on this dimension.
│
├── In-flight RPC continuity across daemon reconnect
│   Coupled to the above. With connectionStateRecovery enabled AND a
│   recovery-aware presence poll (i.e. "wait N seconds for the same
│   socketId to come back before failing"), an in-flight RPC could
│   survive a brief network blip on the daemon: the daemon's handler
│   keeps running, the ack packet sits in the client's sendBuffer,
│   reconnect flushes it, the caller gets its result. Today the presence
│   poll fast-fails the call as soon as the room is empty, which kills
│   this case. Out of scope for this PR.
│
├── User-affinity routing at the LB
│   Cross-pod RPC overhead is ~3–6ms via the streams adapter. JWT-aware
│   routing (Envoy / Istio / nginx-lua) would be a bigger infra change
│   than the fix itself. Tracked as future-work.
│
├── UI "reconnecting…" indicator
│   Server now waits up to 15s for daemons. Client doesn't yet show that wait
│   in the UI. apiSocket-side change, separate from this PR.
│
├── Tuning the adapter discovery window
│   5s is the streams adapter's default heartbeatInterval. Lowering it
│   would reduce the fresh-pod-startup race but increase Redis chatter.
│
└── Long-running RPCs (> 30s)
    Not supported on either main or this PR. Bash command in the CLI has
    its own 30s cap that races dead-even with the server's 30s emit
    timeout. Bumping requires both server and (possibly added) client
    timeouts.
```

## Reference

- Socket.IO rooms: <https://socket.io/docs/v4/rooms/>
- `fetchSockets()`: <https://socket.io/docs/v4/server-api/#serverfetchsockets>
- Broadcasting events: <https://socket.io/docs/v4/broadcasting-events/>
- Memory usage: <https://socket.io/docs/v4/memory-usage/>
- Streams adapter source: <https://github.com/socketio/socket.io-redis-streams-adapter>
- Connection state recovery: <https://socket.io/docs/v4/connection-state-recovery>
- Discussion #5062 (broadcast emitWithAck waits for all): <https://github.com/socketio/socket.io/discussions/5062>
