# Agent Workflow

## Project Maintenance

- Read the nearest `AGENTS.md` before editing files.
- Keep changes scoped, reviewable, and consistent with existing project conventions.
- Update `.agents/context.md`, `.agents/decisions.md`, and `.agents/open-items.md` when project state or durable decisions change.
- Verify the smallest relevant surface before marking a task complete.
- Commit each completed task with a short Chinese commit subject.

## Sync To Main

When the user says `sync to main` or `synt to main`, they mean:

1. Fetch `origin/main`.
2. Rebase the current branch on `origin/main`.
3. Push the current HEAD directly to `main` with a normal push, for example:
   `git push origin HEAD:main`

Do not force push for this workflow.
