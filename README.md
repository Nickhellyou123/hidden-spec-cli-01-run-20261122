[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Nickhellyou123/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Nickhellyou123/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats, and `mend` reads them all: unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing
is. See `SPEC.md` for the whole specification.

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122)
("Build mend, one patch tool for every AI edit format").

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file; when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`;
  `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).
- Node 22 and its standard library alone; no dependencies.

## Exit codes and output

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or `R old -> new`),
  then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`.
  A failed edit changes nothing, and no file is written at all.
- Exit 2: one line — `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>`.

## How matching works

Old lines are found at the first of three tiers at which they occur: exact (tier 0), trailing
whitespace ignored (tier 1), or leading and trailing whitespace ignored (tier 2, with new lines
re-indented to the file's indentation). Unified hunks take the occurrence nearest their (often
wrong) line number; SEARCH/REPLACE blocks fail as `ambiguous` when the old lines occur more than
once; V4A chunks follow an anchor and a cursor, and `*** End of File` anchors a chunk to the end
of the file.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the trial runner (kept as the kit ships it).
- `check.ts` — run the practice set: `node check.ts ../program/generator/practice.json`.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

## Local grade

Practice score **1000** (100 of 100 practice checks pass), plus 52 of 52 extra
adversarial checks written against the specification's edge cases (wrong line numbers, drifted
whitespace and indentation, CRLF files, files without a final line break, moves and renames,
unsafe paths, empty patches, usage errors).
