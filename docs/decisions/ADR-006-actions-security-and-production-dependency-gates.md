# ADR-006: Actions supply-chain controls and production dependency gates

## Status

Accepted; implementation requires a successful main CodeQL run before its required
check is added to the repository ruleset.

## Date

2026-08-12

## Context

Happy deliberately accepts Actions from the full GitHub Actions marketplace because
the existing CI, release, Android, and Relay workflows rely on a broad, evolving set
of upstream Actions. The repository already enforces full commit-SHA pinning for
external Actions and disables credential persistence for every checkout, but it had
no npm Dependabot schedule, no CodeQL analysis, and only a Critical production
dependency audit.

The dependency review API is not a suitable substitute for this gate: it evaluates
all dependency changes, including development-only dependencies, while the approved
policy applies only to production dependencies with High or Critical severity. The
repository currently has no automatic production deployment, GitHub Environment, or
deployment target to protect with approval gates.

## Decision

### Actions permissions and updates

- Keep repository Actions permissions as `allowed_actions=all`.
- Keep full commit-SHA pinning mandatory for every external Action and retain the
  source test that rejects mutable references and persisted checkout credentials.
- Dependabot maintains both GitHub Actions and npm dependencies on a weekly schedule.
  It opens pull requests only; it does not auto-merge, publish, or deploy.
- Enable GitHub vulnerability alerts and Dependabot automated security fixes after
  this implementation is merged. Those repository settings are separately verified
  through the GitHub API because a YAML file cannot enable them.

### CodeQL

- Use a repository-owned advanced CodeQL workflow rather than GitHub's default setup,
  so all CodeQL Actions remain pinned to full commit SHAs.
- Analyze `actions`, `javascript-typescript`, `python`, and `rust` with
  `build-mode: none`. The repository's only Go file is an unmoduleized seven-line CLI
  demo, not a supported Go build surface, so it is not included merely to create a
  failing or empty analysis. A docs-only pull request runs only the classifier and a stable
  `Required CodeQL gate`; source analysis is skipped without leaving a required check
  pending.
- After the workflow succeeds once on `main`, add only `Required CodeQL gate` to the
  existing `main PR and stable CI gates` ruleset. The full ruleset payload must be
  preserved when making that API update.

### Production dependency audit

- Block production dependency changes containing High or Critical advisories.
- The sole temporary exceptions are the two exact `image-size` GHSA advisories reached
  only through `packages__happy-app>expo>@expo/metro>metro>image-size`, because the
  upstream advisory reports no patched release. The exception expires on 2026-11-12
  and fails closed if the advisory ID, module, path, or patch status changes.
- Do not use Dependency Review as a required gate for this policy. It would expand the
  approved High/Critical production scope to development dependency findings.

### Deployment boundary

There is no automatic production deployment. GitHub Environments, deployment approval,
post-deploy health checks, and rollback gates are therefore not configured or claimed.
If a production deployment target is introduced, it requires a new decision defining
the environment, approvers, health checks, rollback procedure, and credentials.

## Consequences

- Pull requests gain a stable CodeQL check without reintroducing a full analysis for
  documentation-only changes.
- Dependabot may open security-update pull requests that remain subject to the normal
  required CI gates.
- High/Critical production dependency regressions fail before merge, while the two
  narrowly scoped unfixable Metro findings stay visible and time-bounded.
- Repository security settings and ruleset changes remain explicit GitHub operations
  with audit evidence; they are not inferred from committed workflow files.

## Verification

- Run the audit script and its Node tests against the frozen lockfile.
- Verify all workflow YAML files structurally, run the Action SHA security test, and
  confirm a docs-only pull request produces a successful `Required CodeQL gate`.
- After merge, verify vulnerability alerts and automated security fixes through the
  GitHub API, then verify a successful main CodeQL run before adding the required
  ruleset context.
