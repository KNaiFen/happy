# Decisions

- [2026-07-27] Extend the existing `.agents/` directory for durable project memory.
  - Why: The directory already contains repository-specific skills and agent guidance.
  - Impact: Project context, decisions, and open items live alongside the existing agent assets without changing their layout.

- [2026-07-27] Keep the existing root `AGENTS.md` synchronization procedure and add only repository-wide maintenance rules.
  - Why: The existing procedure is a deliberate project workflow that remains applicable.
  - Impact: Future tasks have both the established main-branch synchronization rules and a persistent task-completion contract.

- [2026-07-27] Document model-aware Codex reasoning effort as a capability-driven proposal.
  - Why: Codex effort support differs by model, and static global lists already lag the installed Codex protocol.
  - Impact: The proposed implementation publishes local `model/list` capabilities from the CLI, gates advanced app options on advertised support, and requires the CLI to ship before the app consumer.

- [2026-07-27] Treat the installed Codex app-server model catalog as the reasoning-effort source of truth.
  - Why: Effort values are forward-compatible strings, while valid values and defaults differ by model and can change independently of Happy.
  - Impact: Machine and session metadata carry encrypted per-model levels plus the provider default marker; the synthetic `default model` continues to mean Happy's configured launch model, catalog pagination has a total timeout and page cap, and the CLI revalidates every turn with an `xhigh` compatibility fallback when discovery is unavailable.

- [2026-07-27] Disable Expo OTA only for self-contained local Android release builds.
  - Why: The official production channel shares runtime version 21 and replaces the custom embedded bundle on the next cold launch.
  - Impact: `HAPPY_DISABLE_OTA=1` removes the update endpoint during prebuild; `android:local-release` always sets the flag before assembling the APK, while normal upstream build profiles keep their existing OTA behavior.

- [2026-07-27] Target self-contained local Android release builds to arm64-v8a.
  - Why: The intended Snapdragon 8 Elite device uses a 64-bit ARM CPU, so bundling 32-bit ARM and emulator x86 libraries only increases APK size.
  - Impact: `android:local-release` passes `-PreactNativeArchitectures=arm64-v8a`; normal upstream Android build profiles retain their existing architecture configuration.

- [2026-07-27] Keep Agent Defaults in device-local storage and mirror them to account settings.
  - Why: Account settings can briefly return an older value during startup and must not undo an explicit device selection after an app restart.
  - Impact: Agent Defaults migrate once from synced settings, all runtime consumers read the local copy, and changes continue to sync for backward compatibility.

- [2026-07-27] Increment affected distributables by one minor version for every completed code-change task.
  - Why: Locally built APP and CLI artifacts need unambiguous filenames and in-product versions.
  - Impact: This task advances the APP to 1.8.0 and the CLI npm package to 1.3.0; each future task that changes either distributable resets its patch component while incrementing its minor component.

- [2026-07-27] Bundle the workspace `@slopus/happy-wire` implementation into the CLI distribution.
  - Why: A local CLI tgz must not resolve an older npm-published wire package that lacks exports used by the current workspace source.
  - Impact: `@slopus/happy-wire` is a CLI build dependency rather than a runtime dependency, so pkgroll inlines it and users still install only the `happy` package.
