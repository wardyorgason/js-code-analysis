---
name: js-code-analysis
description: Run a repository-wide JavaScript / TypeScript code analysis that measures unit test coverage (with the project's own runner, Vitest, Jest, or c8 for mocha/node:test/others) and file complexity (FTA, Fast TypeScript Analyzer), then writes a single AI-readable CODE_ANALYSIS_REPORT.md with prioritized hotspots, untested functions, and remediation guidelines into the project directory. Use this whenever someone asks to analyze, assess, audit, or measure a JS/TS/Node/React/Vue repo or package for code quality, complexity, maintainability, technical debt, test coverage, missing tests, or "what should we refactor / test next", even if they don't mention FTA or coverage tools. Also use it when the project has no coverage package yet; the skill detects that and asks before installing one.
---

# JS/TS code analysis (coverage + FTA complexity)

The bundled script `scripts/analyze.mjs` (Node 18+; FTA and c8 are vendored in `vendor/`, so nothing is fetched with npm/npx) takes a project directory and produces one markdown report a later agent can act on. It:

1. detects the package manager, test runner (Vitest, Jest, mocha, node:test, ava, or an unrecognised `test` script) and whether a coverage tool is installed;
2. lists source files (git-aware; tests, build output, config, `.d.ts` and generated files excluded) and maps each to the test files that import it;
3. runs the bundled FTA 3.0.1 binary for per-file complexity;
4. runs the tests with coverage into a temporary directory (Vitest `--coverage`, Jest `--coverage`, or the bundled `c8` wrapping the test command), never into the project;
5. joins both, derives per-function data from the coverage output (untested functions, approximate function complexity), ranks hotspots and writes `CODE_ANALYSIS_REPORT.md`.

## Step 1: check what is needed, and warn the user

Always run the check first. It changes nothing:

```bash
node ~/.claude/skills/js-code-analysis/scripts/analyze.mjs <project-dir> --check
```

It prints the detected runner and coverage tool, then an `actions` list of commands that must run first. Possible actions:

- `add-coverage`: only for Vitest, which needs `@vitest/coverage-v8` installed in the project at the same version as its Vitest (it cannot be bundled). Jest needs nothing; mocha, node:test, ava and unrecognised runners use the bundled c8.
- `install-deps`: `node_modules` is missing, so the tests cannot run.

If `actions` is empty, go to step 2 and just tell the user in one line that the run executes the full test suite.

If `actions` is not empty, **do not install anything yet**. Tell the user exactly which command(s) will run and that they add a devDependency to `package.json` and the lockfile, and that the run executes the full test suite. Then ask them to choose (AskUserQuestion works well):

- install and run the full analysis (`--install`);
- run complexity only, without tests or coverage (`--skip-tests`);
- stop, so they can install it themselves.

If you skip the check and run without `--install`, the script refuses with exit code 3 and prints the same list; treat that exactly like a non-empty `actions` list.

## Step 2: run the analysis

```bash
node ~/.claude/skills/js-code-analysis/scripts/analyze.mjs <project-dir> [--install | --skip-tests] [options]
```

Use a generous Bash timeout (`600000` ms) or run it in the background for large suites; progress goes to stderr, and the summary JSON plus the report path go to stdout.

| Option | Use when |
|---|---|
| `--install` | The user approved the actions from `--check` |
| `--skip-tests` | The user wants complexity only, declined the install, or the suite cannot run |
| `--src <dir>` | Source is not in `./src` (repeatable). Without it: `./src` if present, else the whole project |
| `--runner <name>` | Detection picked the wrong runner (`vitest`, `jest`, `mocha`, `node-test`, `ava`, `other`) |
| `--test-command "<cmd>"` | The test script is a chain (`build && vitest`) or needs setup; coverage flags are appended to it (Vitest/Jest) or c8 wraps it |
| `--test-args "<args>"` | Filters or extra flags, e.g. `--test-args "--project unit"` |
| `--test-timeout <min>` | Suites longer than 30 minutes |
| `-o <file>` | The report should go somewhere other than `<project>/CODE_ANALYSIS_REPORT.md` |
| `--keep-artifacts` / `--artifacts-dir <dir>` | You need `coverage-final.json`, `test-results.json` or the test log afterwards |
| `-v` | Stream test output so long runs are visible |

## Step 3: after the run

1. Read the report. Sections 1 and 2 matter most: the summary JSON and the ranked hotspot list. `references/report-format.md` explains every section and finding code.
2. Relay to the user, briefly: test result counts; overall line/branch coverage and how many files no test loads; how many critical/high hotspots; the top few with `file:line`; and any packages the run installed (Section 4.2). The report has the detail.
3. If tests failed, say so first and point at Section 5. Coverage from a failing run under-reports; the complexity half is still valid.
4. Check Section 4.4 for warnings (wrong source root, unrecognised test script, workspace root). Re-run with `--src`, `--runner` or `--test-command` if needed.
5. Suggest adding `CODE_ANALYSIS_REPORT.md` to `.gitignore` if the user does not want it committed; do not edit `.gitignore` unasked.
6. If the user asks you to fix things, work through Section 2 in order and follow Section 3 (the remediation guidelines). Batch related hotspots into a few commits rather than one per hotspot, with single-line commit messages. Re-run the analysis afterwards to confirm the findings are gone.

## Known limits

- FTA scores whole files. Function names, lines and complexity come from the coverage data, so function-level findings only exist when tests ran. Function complexity is approximate (1 + branches recorded by istanbul/V8 inside the function).
- Monorepos: point the tool at one package, or at a root that runs all packages through one Vitest/Jest config (Vitest `projects`, Jest `projects`). A workspace root without its own runner gets a warning.
- `bun test` and Deno are not supported for coverage; use `--skip-tests`, or `--runner other --test-command "<node-based command>"`.
- Coverage thresholds in the project's config may make the test command exit non-zero; the tool reads the test results to tell that apart from real failures.
- Jest `projects` and Vitest `projects` are run as-is; the tool does not add per-project flags.

## Maintaining the skill

The source lives in the `js-code-analysis` repository (`skill/` is this directory). `scripts/bundle.sh` there refreshes `vendor/` (FTA binaries for macOS and Linux; `--all-platforms` adds Windows). Install or update with `scripts/install.sh`, which copies `skill/` to `~/.claude/skills/js-code-analysis` and writes `VERSION`. Do not edit the installed copy; changes are lost on the next install. The remediation text embedded in every report is `references/remediation-guidelines.md`; `--guidelines <file>` overrides it for one run.
