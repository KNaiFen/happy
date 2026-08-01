# Lab Rat Todo Project

A tiny frontend-only todo app. No build step, no dependencies. Opens via
`index.html`. Stores todos in localStorage.

## Purpose

This project exists to **exercise the official Codex app-server through Happy**.
It is the standard fixture for validating Codex protocol behavior end to end.

It is intentionally small (4 source files) but has real bugs, missing features,
and enough surface area to trigger every protocol primitive an agent supports:
permissions, subagents, questions, todos, sandbox boundaries, compaction,
model switching, session resume.

## Files

- `index.html` — app shell
- `styles.css` — layout and theme
- `app.js` — todo logic and localStorage persistence
- `AGENTS.template.md` — tracked source that the environment manager materializes
  as Codex-native `AGENTS.md`
- `exercise-flow.md` — 20-step scripted interaction sequence with expected
  outcomes and protocol primitive coverage

## Known issues (intentional)

- The "Done" filter is broken — shows all items instead of only completed ones
- No dark mode
- No tests or test framework
- No keyboard shortcuts
- Delete has no confirmation

These exist so agents have concrete work to do during the exercise.

## How to use

Create an isolated Happy environment, point Codex at the generated project, and
work through `exercise-flow.md`.
