# CODE_ANALYSIS_REPORT.md format

The analyzer writes one markdown file into the project directory (or wherever `-o` points). It is written for an agent to read, so the actionable parts come first and the raw data last.

| Section | Contents | When to read it |
|---|---|---|
| Header | Timestamp, project root, source roots, exact command, tools used | Always; confirm it is the run you expect |
| 1. Summary | JSON block (tests, coverage totals, complexity totals, hotspot counts, modifications), then the same in prose | Always; relay this to the user |
| 2. Critical areas to address | Ranked table of hotspots (project, file or function) with severity, location, why and the recommended action, then a detail subsection per hotspot: metrics, findings, existing tests or a suggested test path, functions never called by tests, uncovered lines | Always; this is the work list for a fixing agent |
| 3. Remediation guidelines | G0-G5 conventions a fixing agent must follow, plus commit rules | When fixing |
| 4. Scope | 4.1 detection (package manager, runner, coverage tool, test layout); 4.2 changes the run made to the project; 4.3 what was excluded; 4.4 warnings | When something looks missing or wrong |
| 5. Test execution | Command, status, counts, failing tests with messages, test files that failed to load, output tail | When tests failed or coverage is empty |
| 6. Coverage (full) | 6.1 totals; 6.2 every source file, lowest coverage first, with untested functions | When choosing what to test |
| 7. Complexity (full) | 7.1 metric definitions and thresholds; 7.2 every file by FTA score; 7.3 the 40 most complex functions | When choosing what to refactor |
| Appendix | Artifacts, FTA run details, measurement caveats | Rarely |

## Severity vocabulary

Project level:

- **TestsFailing** (Critical): failing tests or a timed-out run. **NoTestRunner** (Critical): nothing to run tests with. **CoverageMissing** (High): tests ran but produced no coverage.

File level (FTA metrics are per file):

- **ComplexAndUntested** (Critical): FTA > 60 with cyclomatic ≥ 10 (or cyclomatic ≥ 25) and line coverage < 50%.
- **SevereComplexity** (Critical): FTA > 75 with cyclomatic ≥ 20.
- **NeedsImprovement** (High): FTA > 60, cyclomatic ≥ 10. **CouldBeBetter** (Medium): FTA 50-60, cyclomatic ≥ 10.
- **DataHeavy** (Low): FTA > 50 but cyclomatic < 10; usually tables or config. Not in Section 2.
- **HugeFile** (High) > 1000 lines; **LargeFile** (Medium) > 500 lines; **HighCyclomatic** (Medium) cyclomatic > 50 without a high FTA score.
- **NoCoverage**: 0% line coverage. High when cyclomatic ≥ 5, Medium when ≥ 2, Low otherwise.
- **LowCoverage** (Medium) < 50%; **PartialCoverage** (Low) < 80%; **LowBranchCoverage** (Medium) < 50% of ≥ 4 branches.

Function level (only when coverage ran, since function boundaries come from the coverage data):

- **UntestedComplexFunction**: never called in tests and approx. complexity ≥ 10 (High) or ≥ 20 (Critical).
- **ComplexFunction**: approx. complexity ≥ 20 (Medium) or ≥ 30 (High), whatever its coverage.
- **PoorlyTestedComplexFunction** (Medium): called, but < 50% of its statements run, complexity ≥ 10.
- **LongFunction**: > 80 lines (Medium), > 150 (High).

Within a severity, items are ordered by a CRAP-style risk: complexity² × (1 − coverage)³ + complexity.

## Coverage states

- `measured`: the coverage tool reported the file.
- `0% (never loaded by a test)`: tests ran but no test imported the file, so it is absent from the coverage data. Counted as fully uncovered using FTA's line count.
- `0% (no tests)`: the project has no test runner.
- `? (tests skipped)` / `? (no coverage data)`: `--skip-tests`, or the run failed to write coverage.

## Test map

Each file's "existing tests" are test files that import it by relative path (including `vi.mock`/`jest.mock` paths) or share its name (`foo.ts` ↔ `foo.test.ts`, `bar/index.ts` ↔ `bar.test.ts`). Package-alias imports (`@/lib/foo`) are matched only by name.
