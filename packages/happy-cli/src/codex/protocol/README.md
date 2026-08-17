# Codex app-server protocol

`generated/` contains the unmodified stable TypeScript schema emitted by
`codex-cli 0.147.0`, plus `GENERATOR.json` and the derived
`STABLE_METHODS.json` runtime allowlist. Experimental methods and fields are
deliberately excluded.

Regenerate it with:

```sh
pnpm --filter happy codex:protocol:generate
```

The generator rejects other Codex versions so protocol updates are explicit and
reviewable. Runtime compatibility is checked separately and accepts Codex
`0.147.0` or newer.
