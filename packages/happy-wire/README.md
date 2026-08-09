# @slopus/happy-wire

Shared runtime schemas for Happy's Codex-only protocol surface.

The package contains:

- Codex Sync V4 mutation, snapshot, entity, command, request, lifecycle, and diagnostic schemas.
- Socket invalidation hints for waking V4 pollers.
- Session and machine control-plane update schemas still used by Codex clients.
- Shared voice and task-notification helpers.

The retired V3 message channel is intentionally not exported. The pre-encryption
Sync V4 entity schemas include provider metadata and conversation fields so
clients can encrypt them; the relay receives only the encrypted mutation
ciphertext and its routing metadata.

## Requirements

- Node.js 20 or newer
- TypeScript 5.9

## Development

Run source-only checks from the repository root:

```bash
./node_modules/.bin/tsc --noEmit -p packages/happy-wire/tsconfig.json
./node_modules/.bin/vitest run --root packages/happy-wire --config vitest.config.ts
```

Release builds are produced by the repository's GitHub Actions workflows.

## Main Exports

```typescript
import {
  CodexCommandEntityV4Schema,
  CodexRuntimeEntityV4Schema,
  SyncMutationV4Schema,
  SyncSnapshotV4Schema,
  SyncV4CapabilitiesSchema,
  UpdateMachineBodySchema,
  UpdateSessionBodySchema,
} from '@slopus/happy-wire';
```

All Codex schemas use stable-v2 provider semantics. Sync V4 payloads remain opaque to the relay;
clients encrypt and decrypt entity ciphertext end to end.

## License

MIT
