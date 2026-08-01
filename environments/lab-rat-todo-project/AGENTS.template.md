# Happy Codex Lab Rat Instructions

Instruction sentinel: `HAPPY_CODEX_LAB_RAT_INSTRUCTIONS_V1`.

This is a test fixture, not a production application. It exercises the official
Codex app-server and Happy's remote-control protocol against a small but
realistic codebase.

## Project

The project is a frontend-only todo app with no build step or dependencies. Open
`index.html` in a browser. Todos are stored in `localStorage`.

Known intentional gaps:

- The Done filter compares the wrong string and shows every item.
- There is no dark mode.
- There are no tests or test framework.
- Delete has no confirmation.
- There is no keyboard shortcut for adding a todo.

## Exercise Rules

Follow `exercise-flow.md` in order. Execute one user interaction at a time and
observe the resulting Codex/Happy protocol lifecycle. Do not skip or batch
steps, because ordering, approvals, tools, compaction, resume, and child-session
behavior are part of the fixture contract.
