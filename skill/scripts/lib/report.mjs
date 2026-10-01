import path from 'node:path';
import { THRESHOLDS, SEVERITIES } from './findings.mjs';
import { escapeCell as esc, fmtNum, fmtPct, lineRanges, pct } from './util.mjs';

const MAX_TABLE_ROWS = 60;

function sum(files, pick) {
  const t = { covered: 0, total: 0 };
  for (const f of files) {
    const v = pick(f);
    if (v) {
      t.covered += v.covered;
      t.total += v.total;
    }
  }
  return t;
}

// Line totals include files no test loaded, counted as fully uncovered using FTA's line count.
export function coverageTotals(files) {
  const measured = files.filter((f) => f.covState === 'measured');
  const notLoaded = files.filter((f) => f.covState === 'not-loaded');
  const lines = sum(measured, (f) => f.coverage.lines);
  const unloadedLines = notLoaded.reduce((s, f) => s + (f.fta?.lineCount ?? 0), 0);
  return {
    lines: pct(lines.covered, lines.total + unloadedLines),
    linesMeasuredOnly: pct(lines.covered, lines.total),
    branches: pct(...Object.values(sum(measured, (f) => f.coverage.branches))),
    functions: pct(...Object.values(sum(measured, (f) => f.coverage.functions))),
    statements: pct(...Object.values(sum(measured, (f) => f.coverage.statements))),
    filesMeasured: measured.length,
    filesNotLoaded: notLoaded.length,
    filesFullyUncovered: files.filter((f) => f.linePct === 0).length,
  };
}

function round(v) {
  return v === null || v === undefined ? null : Math.round(v * 10) / 10;
}

export function buildSummary(ctx) {
  const { detection, files, hotspots, testRun, coverageMode, modifications } = ctx;
  const scored = files.filter((f) => f.fta);
  const totals = coverageMode === 'measured' ? coverageTotals(files) : null;
  const count = (sev) => hotspots.filter((h) => h.severity === sev).length;
  return {
    project: detection.name ?? path.basename(detection.root),
    packageManager: detection.packageManager,
    typescript: detection.typescript,
    testRunner: detection.runner.runner,
    coverageTool: detection.coverage.tool,
    sourceFiles: files.length,
    testFiles: ctx.testsCount,
    tests: testRun?.ran
      ? { status: testRun.status, ...(testRun.counts ?? {}), durationSeconds: Math.round(testRun.durationMs / 1000) }
      : { status: coverageMode === 'skipped' ? 'skipped' : coverageMode === 'none' ? 'no test runner' : 'not run' },
    coverage: totals
      ? {
          linesPct: round(totals.lines),
          linesPctOfLoadedFiles: round(totals.linesMeasuredOnly),
          branchesPct: round(totals.branches),
          functionsPct: round(totals.functions),
          statementsPct: round(totals.statements),
          filesMeasured: totals.filesMeasured,
          filesNeverLoadedByTests: totals.filesNotLoaded,
          filesWithZeroCoverage: totals.filesFullyUncovered,
        }
      : { status: coverageMode === 'none' ? 'no tests' : coverageMode },
    complexity: {
      filesScored: scored.length,
      averageFtaScore: round(scored.reduce((s, f) => s + f.fta.score, 0) / (scored.length || 1)),
      needsImprovement: scored.filter((f) => f.fta.score > THRESHOLDS.ftaNeedsImprovement).length,
      couldBeBetter: scored.filter((f) => f.fta.score > THRESHOLDS.ftaCouldBeBetter && f.fta.score <= THRESHOLDS.ftaNeedsImprovement).length,
      ok: scored.filter((f) => f.fta.score <= THRESHOLDS.ftaCouldBeBetter).length,
      totalCyclomatic: scored.reduce((s, f) => s + f.fta.cyclo, 0),
    },
    hotspots: { critical: count('Critical'), high: count('High'), medium: count('Medium') },
    modifications: modifications.map((m) => m.command),
  };
}

function suggestTestPath(record, layout) {
  const file = record.file;
  const dir = path.posix.dirname(file);
  const ext = path.posix.extname(file);
  const stem = path.posix.basename(file, ext);
  const suffix = layout.suffix ? layout.suffix.replace(/\.[cm]?[jt]sx?$/, '') + ext : `.test${ext}`;
  if (layout.style === '__tests__') return `${dir}/__tests__/${stem}${suffix}`;
  if (layout.style === 'separate dir') {
    const top = layout.example?.split('/')[0] ?? 'test';
    const inner = dir.replace(/^src(\/|$)/, '');
    return path.posix.join(top, inner, `${stem}${suffix}`);
  }
  return `${dir === '.' ? '' : dir + '/'}${stem}${suffix}`;
}

function metricsLine(r) {
  const parts = [];
  if (r.fta) parts.push(`FTA ${r.fta.score.toFixed(1)} (${r.fta.assessment})`, `cyclomatic ${r.fta.cyclo}`, `${r.fta.lineCount} lines`);
  else parts.push('FTA: not scored (file under 6 lines or unparseable)');
  parts.push(`line coverage ${covText(r)}`);
  if (r.coverage) parts.push(`branch ${fmtPct(r.branchPct)}`, `functions ${r.coverage.functions.covered}/${r.coverage.functions.total}`);
  return parts.join(' · ');
}

function covText(r) {
  switch (r.covState) {
    case 'measured':
      return fmtPct(r.linePct);
    case 'not-loaded':
      return '0% (never loaded by a test)';
    case 'no-tests':
      return '0% (no tests)';
    case 'skipped':
      return '? (tests skipped)';
    default:
      return '? (no coverage data)';
  }
}

function hotspotDetails(h, i, layout) {
  const r = h.record;
  const lines = [];
  lines.push(`### 2.${i + 1} [${h.severity}] ${h.kind === 'function' ? `\`${h.target}\` in \`${h.location}\`` : `\`${h.target}\``}`);
  lines.push('');
  if (h.kind === 'project') {
    for (const f of h.findings) lines.push(`- **${f.code}**: ${f.message}`, `  - Action: ${f.action}`);
    return lines.join('\n');
  }
  if (h.kind === 'function') {
    const fn = h.fn;
    const stmt = fn.statements.total ? `${fn.statements.covered}/${fn.statements.total} statements covered` : 'no statements recorded';
    lines.push(`- Location: \`${r.file}:${fn.line}-${fn.endLine}\` (${fn.length} lines)`);
    lines.push(`- Metrics: approx. cyclomatic ${fn.complexity} · called ${fn.hits}× in tests · ${stmt}`);
    lines.push(`- File: ${metricsLine(r)}`);
  } else {
    lines.push(`- Metrics: ${metricsLine(r)}`);
  }
  for (const f of h.findings) lines.push(`- **${f.code}** (${f.severity}): ${f.message}`);
  lines.push(`- Action: ${[...new Set(h.findings.map((f) => f.action))].join(' ')}`);
  lines.push(r.tests.length
    ? `- Existing tests touching this file: ${r.tests.map((t) => `\`${t}\``).join(', ')}`
    : `- No test file references this file. Suggested location: \`${suggestTestPath(r, layout)}\``);
  if (h.kind === 'file' && r.coverage) {
    const untested = r.coverage.functions.list.filter((f) => f.hits === 0);
    if (untested.length) {
      const shown = untested.slice(0, 15).map((f) => `\`${fnLabel(f)}\` (L${f.line}${f.complexity > 1 ? `, cx ${f.complexity}` : ''})`);
      lines.push(`- Functions never called by tests (${untested.length}): ${shown.join(', ')}${untested.length > 15 ? ', …' : ''}`);
    }
    if (r.coverage.uncoveredLines.length && r.linePct > 0) {
      lines.push(`- Uncovered lines: ${lineRanges(r.coverage.uncoveredLines)}`);
    }
  }
  return lines.join('\n');
}

function fnLabel(f) {
  return !f.name || /^\(anonymous_\d+\)$/.test(f.name) ? 'anonymous' : f.name;
}

export function renderReport(ctx) {
  const { detection, files, hotspots, testRun, coverageMode, modifications, warnings, guidelines, layout, summary } = ctx;
  const out = [];
  const push = (...l) => out.push(...l);

  push(`# Code Analysis Report: ${summary.project}`, '');
  push(`- Generated: ${ctx.generatedAt}`);
  push(`- Project root: \`${detection.root}\``);
  push(`- Source roots analysed: ${ctx.sourceRoots.map((s) => `\`${path.relative(detection.root, s) || '.'}\``).join(', ')}`);
  push(`- Command: \`${ctx.commandLine}\``);
  push(`- Tools: FTA ${ctx.ftaVersion} (per-file complexity) + ${detection.coverage.tool ?? 'no coverage tool'} (unit test coverage)`);
  push('');
  push('> **For AI agents:** Section 1 is the summary, Section 2 is the prioritised work list (fix in that order), and Section 3 holds the conventions to follow while fixing. Sections 4-7 are reference data. File paths are relative to the project root; `file:line` points at the function start.');
  push('');

  // 1. Summary
  push('## 1. Summary', '', '```json', JSON.stringify(summary, null, 2), '```', '');
  push(...summaryProse(summary, coverageMode), '');

  // 2. Hotspots
  push('## 2. Critical areas to address', '');
  if (!hotspots.length) {
    push('No Medium-or-worse findings. Section 7 still lists every file if you want to tidy further.', '');
  } else {
    push(`Ranked by severity, then by risk (CRAP-style: complexity² × (1 − coverage)³ + complexity). ${hotspots.length} item(s)${hotspots.length > MAX_TABLE_ROWS ? `; the first ${MAX_TABLE_ROWS} are tabled` : ''}.`, '');
    push('| # | Severity | Target | Location | Why | Action |', '|---|---|---|---|---|---|');
    hotspots.slice(0, MAX_TABLE_ROWS).forEach((h, i) => {
      const why = h.findings.map((f) => `${f.code}: ${f.message}`).join(' ');
      const action = [...new Set(h.findings.map((f) => f.action))].join(' ');
      push(`| ${i + 1} | ${h.severity} | ${esc(h.target)} | ${h.location ? `\`${esc(h.location)}\`` : ''} | ${esc(why)} | ${esc(action)} |`);
    });
    push('');
    const detailCount = Math.min(hotspots.length, ctx.maxDetails);
    hotspots.slice(0, detailCount).forEach((h, i) => push(hotspotDetails(h, i, layout), ''));
    if (hotspots.length > detailCount) push(`_${hotspots.length - detailCount} more item(s) are in the table above without a detail section; Sections 6 and 7 have their data._`, '');
  }

  // 3. Guidelines
  push('## 3. Remediation guidelines', '', guidelines.trim(), '');

  // 4. Scope
  push('## 4. Scope', '', '### 4.1 Project detection', '');
  push('| Item | Value |', '|---|---|');
  push(`| Package manager | ${detection.packageManager ?? 'n/a'} |`);
  push(`| TypeScript | ${detection.typescript ? 'yes' : 'no'} |`);
  push(`| Test runner | ${detection.runner.runner} (${esc(detection.runner.reason)}) |`);
  push(`| Coverage tool | ${detection.coverage.tool ?? 'none'}: ${esc(detection.coverage.reason)} |`);
  push(`| Workspace root | ${detection.isWorkspaceRoot ? `yes (${esc(detection.workspaces.join(', ') || 'pnpm-workspace.yaml')})` : 'no'} |`);
  push(`| Source files analysed | ${files.length} |`);
  push(`| Test files found | ${ctx.testsCount} (layout: ${layout.style}${layout.example ? `, e.g. \`${layout.example}\`` : ''}) |`);
  push(`| File listing | ${ctx.viaGit ? 'git (respects .gitignore)' : 'directory walk (not a git work tree)'} |`);
  push('');
  push('### 4.2 Repository modifications made by this run', '');
  if (modifications.length) for (const m of modifications) push(`- \`${m.command}\` (${m.why}) → ${m.ok ? 'succeeded' : 'FAILED'}`);
  else push('- None. The report file itself and a temporary artifacts directory are the only writes.');
  push('');
  push('### 4.3 What is excluded', '');
  push('- Test files (`*.test.*`, `*.spec.*`, `*.e2e.*`, `*.cy.*`) and anything under `__tests__`, `__mocks__`, `test`, `tests`, `spec`, `e2e`, `fixtures`, `cypress`, `playwright` directories. They are used for the test map, not scored.');
  push('- `node_modules`, build output (`dist`, `build`, `out`, tsconfig `outDir`), `coverage`, `public`, `static`, `vendor`, dot-directories.');
  push('- Type declarations (`*.d.ts`), minified/bundled files, `*.stories.*`, tool config files (`*.config.*`, `.*rc.js`), test setup files, and files marked `@generated` / "do not edit" in their header.');
  if (ctx.userFtaConfig) push(`- Extra exclusions from \`${path.relative(detection.root, ctx.userFtaConfig.file)}\`.`);
  push('');
  push('### 4.4 Warnings', '');
  if (warnings.length) for (const w of warnings) push(`- ${w}`);
  else push('- None.');
  push('');

  // 5. Test execution
  push('## 5. Test execution', '');
  if (!testRun?.ran) {
    push(testRun?.error ? `Tests were not run: ${testRun.error}` : coverageMode === 'skipped' ? 'Tests were skipped (`--skip-tests`).' : 'No test runner, so no tests were run.', '');
  } else {
    push(`- Command: \`${testRun.command}\``);
    push(`- Status: **${testRun.status}** (exit code ${testRun.exitCode ?? 'n/a'}, ${Math.round(testRun.durationMs / 1000)}s)`);
    if (testRun.counts) {
      const c = testRun.counts;
      push(`- Tests: ${c.total} total, ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped${c.suites !== null && c.suites !== undefined ? ` (${c.suites} suites, ${c.failedSuites} failed)` : ''}`);
    } else push('- Test counts could not be parsed from the output.');
    for (const n of testRun.notes) push(`- Note: ${n}`);
    push('');
    if (testRun.failures.length) {
      push('### 5.1 Failing tests', '');
      for (const f of testRun.failures.slice(0, 30)) {
        push(`- \`${path.relative(detection.root, f.file)}\` › ${f.name}`, '', '  ```', ...f.message.split('\n').map((l) => `  ${l}`), '  ```');
      }
      if (testRun.failures.length > 30) push(`- … ${testRun.failures.length - 30} more`);
      push('');
    }
    if (testRun.suiteErrors.length) {
      push('### 5.2 Test files that failed to run', '');
      for (const s of testRun.suiteErrors.slice(0, 20)) {
        push(`- \`${path.relative(detection.root, s.file)}\``, '', '  ```', ...s.message.split('\n').map((l) => `  ${l}`), '  ```');
      }
      push('');
    }
    if (testRun.status !== 'passed' || !testRun.coverage) {
      push('### 5.3 Output tail', '', '```', testRun.outputTail, '```', '');
    }
  }

  // 6. Coverage
  push('## 6. Coverage (full)', '');
  if (coverageMode !== 'measured') {
    push(`No coverage data (${coverageMode === 'none' ? 'no tests' : coverageMode}). Every file is treated as ${coverageMode === 'none' ? 'untested' : 'unknown'}.`, '');
  } else {
    const t = coverageTotals(files);
    push('### 6.1 Totals', '');
    push(`- Lines: ${fmtPct(t.lines)} across all source files (${fmtPct(t.linesMeasuredOnly)} of files that tests load)`);
    push(`- Statements: ${fmtPct(t.statements)} · Branches: ${fmtPct(t.branches)} · Functions: ${fmtPct(t.functions)}`);
    push(`- Files never loaded by any test: ${t.filesNotLoaded} of ${files.length}`);
    push('');
    push('### 6.2 Per file (lowest line coverage first)', '');
    push('| File | Lines | Branches | Functions | Untested functions | Tests |', '|---|---|---|---|---|---|');
    const sorted = [...files].sort((a, b) => (a.linePct ?? 0) - (b.linePct ?? 0) || (b.fta?.cyclo ?? 0) - (a.fta?.cyclo ?? 0));
    for (const r of sorted) {
      const untested = r.coverage ? r.coverage.functions.list.filter((f) => f.hits === 0) : [];
      const fnText = untested.slice(0, 6).map((f) => `${fnLabel(f)}:${f.line}`).join(', ') + (untested.length > 6 ? `, +${untested.length - 6}` : '');
      push(`| \`${esc(r.file)}\` | ${covText(r)} | ${fmtPct(r.branchPct)} | ${r.coverage ? `${r.coverage.functions.covered}/${r.coverage.functions.total}` : 'n/a'} | ${esc(fnText || (r.covState === 'not-loaded' ? 'all' : '-'))} | ${r.tests.length} |`);
    }
    push('');
  }

  // 7. Complexity
  push('## 7. Complexity (full)', '', '### 7.1 Metrics and thresholds', '');
  push(`- **FTA score** (per file, lower is better): ≤ ${THRESHOLDS.ftaCouldBeBetter} OK, ${THRESHOLDS.ftaCouldBeBetter}-${THRESHOLDS.ftaNeedsImprovement} could be better, > ${THRESHOLDS.ftaNeedsImprovement} needs improvement, > ${THRESHOLDS.ftaSevere} flagged Critical when cyclomatic ≥ 20. Combines Halstead metrics, cyclomatic complexity and size.`);
  push(`- **Cyclomatic** (FTA, per file): decision paths across the whole file. A high FTA score with cyclomatic < ${THRESHOLDS.logicCyclo} is usually data or config and is only reported as DataHeavy (Low).`);
  push(`- **Approx. function complexity** (from coverage data): 1 + the branches istanbul recorded inside the function. Only available when coverage ran. Flagged at ≥ ${THRESHOLDS.fnComplex} when untested, ≥ ${THRESHOLDS.fnVeryComplex} always. Long functions: > ${THRESHOLDS.fnLong} lines Medium, > ${THRESHOLDS.fnVeryLong} High.`);
  push(`- **File size**: > ${THRESHOLDS.fileLinesLarge} lines Medium, > ${THRESHOLDS.fileLinesHuge} High (FTA line count, comments excluded).`);
  push(`- **Coverage**: < ${THRESHOLDS.coverageLow}% Low, < ${THRESHOLDS.coverageTarget}% Partial. Severity words: ${SEVERITIES.join(' > ')}; Low items are omitted from Section 2.`);
  push('');
  push('### 7.2 Per file (highest FTA score first)', '');
  push('| File | FTA | Assessment | Cyclomatic | Lines | Line coverage | Findings |', '|---|---|---|---|---|---|---|');
  const byScore = [...files].sort((a, b) => (b.fta?.score ?? -1) - (a.fta?.score ?? -1));
  for (const r of byScore) {
    const codes = r.findings.map((f) => f.code).join(', ');
    push(`| \`${esc(r.file)}\` | ${r.fta ? fmtNum(r.fta.score) : 'n/a'} | ${r.fta?.assessment ?? 'not scored'} | ${r.fta?.cyclo ?? 'n/a'} | ${r.fta?.lineCount ?? 'n/a'} | ${covText(r)} | ${esc(codes || '-')} |`);
  }
  push('');
  const fns = files.flatMap((r) => (r.coverage?.functions.list ?? []).map((f) => ({ ...f, file: r.file })));
  if (fns.length) {
    push('### 7.3 Most complex functions (top 40 by approx. complexity)', '');
    push('| Function | Location | Approx. complexity | Lines | Calls in tests |', '|---|---|---|---|---|');
    for (const f of fns.sort((a, b) => b.complexity - a.complexity || b.length - a.length).slice(0, 40)) {
      push(`| \`${esc(fnLabel(f))}\` | \`${esc(f.file)}:${f.line}\` | ${f.complexity} | ${f.length} | ${f.hits} |`);
    }
    push('');
  }

  // Appendix
  push('## Appendix', '');
  push(`- Artifacts: ${ctx.artifactsKept ? `\`${ctx.artifactsDir}\` (coverage-final.json, test-results.json, test-output.log, fta.json)` : 'deleted after the run (pass --keep-artifacts to keep them)'}`);
  for (const r of ctx.ftaRuns) push(`- FTA run on \`${path.relative(detection.root, r.root) || '.'}\`: ${r.files} files scored${r.error ? `; error:\n\n  \`\`\`\n${r.error.split('\n').map((l) => `  ${l}`).join('\n')}\n  \`\`\`` : ''}`);
  push('- FTA scores whole files; it does not name functions. Function-level data comes from the coverage report, so it is missing when tests did not run.');
  push('- Files that no test imports are absent from V8/istanbul output; they are counted here as 0% using their FTA line count.');
  if (fns.some(() => true) && files.some((f) => f.coverage?.branchSource === 'v8-blocks')) {
    push('- Branch data came from V8 block ranges (c8 or an older vitest v8 provider), so approx. function complexity counts executed-block boundaries and is rougher than istanbul branch data.');
  }
  push('');
  return out.join('\n');
}

function summaryProse(s, coverageMode) {
  const lines = [];
  const t = s.tests;
  if (t.total !== undefined) lines.push(`- Tests: **${t.status}**. ${t.passed}/${t.total} passed, ${t.failed} failed, ${t.skipped} skipped (${t.durationSeconds}s).`);
  else lines.push(`- Tests: ${t.status}.`);
  if (coverageMode === 'measured') {
    const c = s.coverage;
    lines.push(`- Coverage: ${c.linesPct ?? 'n/a'}% of lines across all ${s.sourceFiles} source files; branches ${c.branchesPct ?? 'n/a'}%, functions ${c.functionsPct ?? 'n/a'}%. ${c.filesNeverLoadedByTests} file(s) are never loaded by any test and ${c.filesWithZeroCoverage} have 0% coverage.`);
  } else {
    lines.push(`- Coverage: not measured (${s.coverage.status}).`);
  }
  const x = s.complexity;
  lines.push(`- Complexity: ${x.filesScored} files scored by FTA, average ${x.averageFtaScore}; ${x.needsImprovement} need improvement (> ${THRESHOLDS.ftaNeedsImprovement}), ${x.couldBeBetter} could be better.`);
  lines.push(`- Hotspots: ${s.hotspots.critical} critical, ${s.hotspots.high} high, ${s.hotspots.medium} medium (Section 2).`);
  if (s.modifications.length) lines.push(`- This run modified the project: ${s.modifications.map((m) => `\`${m}\``).join(', ')}.`);
  return lines;
}
