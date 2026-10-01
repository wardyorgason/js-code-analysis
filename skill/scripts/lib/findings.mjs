import { summariseFileCoverage } from './coverage.mjs';
import { pct, rel } from './util.mjs';

export const THRESHOLDS = {
  ftaNeedsImprovement: 60, // FTA's own "Needs improvement" band
  ftaCouldBeBetter: 50, // FTA's own "Could be better" band
  ftaSevere: 75,
  logicCyclo: 10, // below this a high FTA score is usually data/config, not logic
  fileCycloHigh: 50,
  fileLinesLarge: 500,
  fileLinesHuge: 1000,
  coverageLow: 50,
  coverageTarget: 80,
  fnComplex: 10,
  fnVeryComplex: 20,
  fnLong: 80,
  fnVeryLong: 150,
};

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

// Which remediation guideline applies to each finding code (see references/remediation-guidelines.md).
export const ACTIONS = {
  TestsFailing: 'Fix the failing tests first; coverage from a failing run under-reports (G0).',
  NoTestRunner: 'Set up a test runner (Vitest recommended) and add tests for the hotspots below (G4).',
  CoverageMissing: 'Make the coverage run work (see Section 5), then re-run the analysis.',
  ComplexAndUntested: 'Write characterization tests first, then split the file (G5, then G1-G3).',
  SevereComplexity: 'Split the file by responsibility into smaller modules (G1), flatten branching (G3).',
  NeedsImprovement: 'Extract cohesive parts into their own modules (G1); flatten branching (G3).',
  CouldBeBetter: 'Tidy when next touched: extract helpers (G1), guard clauses (G3).',
  DataHeavy: 'Probably data/config heavy (high score, few branches). Check before refactoring; usually fine.',
  HugeFile: 'Split into modules by responsibility (G1).',
  LargeFile: 'Consider splitting by responsibility (G1).',
  HighCyclomatic: 'Many decision paths in one file; extract branching logic into functions/modules (G3).',
  NoCoverage: 'No test executes this file. Add unit tests (G4).',
  LowCoverage: 'Add tests for the uncovered functions and lines listed (G4).',
  PartialCoverage: 'Cover the remaining functions/branches listed (G4).',
  LowBranchCoverage: 'Add tests for the untaken branches (G4).',
  UntestedComplexFunction: 'Add tests for this function before changing it (G5); split it if complexity stays high (G3).',
  ComplexFunction: 'Break the function up: guard clauses, extracted helpers, lookup tables (G3).',
  PoorlyTestedComplexFunction: 'Add tests for its untested paths (G4).',
  LongFunction: 'Extract cohesive steps into named helper functions (G1).',
};

function finding(code, severity, message) {
  return { code, severity, message, action: ACTIONS[code] };
}

function worst(findings) {
  return findings.reduce((w, f) => (w === null || RANK[f.severity] < RANK[w] ? f.severity : w), null);
}

export function crap(complexity, coveredFraction) {
  const c = coveredFraction ?? 0;
  return complexity * complexity * (1 - c) ** 3 + complexity;
}

/**
 * Joins FTA and coverage per source file and derives findings.
 * coverageMode: 'measured' (coverage data available), 'none' (no test runner),
 *               'skipped' (--skip-tests), 'failed' (run produced no coverage).
 */
export function analyseFiles({ projectRoot, sources, fta, coverageByFile, coverageMode, testMap }) {
  const files = [];
  for (const abs of sources) {
    const f = fta.get(abs) ?? null;
    const fc = coverageByFile?.get(abs);
    let cov = null;
    let covState;
    if (coverageMode === 'measured') {
      if (fc) {
        cov = summariseFileCoverage(fc);
        covState = 'measured';
      } else {
        covState = 'not-loaded';
      }
    } else {
      covState = coverageMode === 'none' ? 'no-tests' : coverageMode;
    }
    const linePct = cov ? pct(cov.lines.covered, cov.lines.total) : covState === 'not-loaded' || covState === 'no-tests' ? 0 : null;
    const branchPct = cov ? pct(cov.branches.covered, cov.branches.total) : null;
    const fnPct = cov ? pct(cov.functions.covered, cov.functions.total) : null;
    const tests = [...(testMap.get(abs) ?? [])].map((t) => rel(projectRoot, t));
    const record = {
      file: rel(projectRoot, abs),
      fta: f,
      coverage: cov,
      covState,
      linePct,
      branchPct,
      fnPct,
      tests,
      findings: [],
      functions: [],
    };
    record.findings = fileFindings(record);
    record.functions = functionHotspots(record);
    const cyclo = f?.cyclo ?? (cov ? cov.functions.list.reduce((s, x) => s + x.complexity, 0) : 1);
    record.risk = linePct === null ? (f?.score ?? 0) : crap(cyclo, linePct / 100);
    record.severity = worst([...record.findings, ...record.functions.flatMap((x) => x.findings)]);
    files.push(record);
  }
  return files;
}

function fileFindings(r) {
  const T = THRESHOLDS;
  const out = [];
  const f = r.fta;
  const hasCoverage = r.linePct !== null;
  const logic = f ? f.cyclo >= T.logicCyclo : (r.coverage?.functions.total ?? 0) >= 3;

  if (f) {
    const complex = (f.score > T.ftaNeedsImprovement && f.cyclo >= T.logicCyclo) || f.cyclo >= 25;
    if (complex && hasCoverage && r.linePct < T.coverageLow) {
      const cov = r.linePct > 0 ? `only ${r.linePct.toFixed(1)}% line coverage`
        : r.covState === 'not-loaded' ? 'no coverage (no test loads it)' : 'no coverage';
      out.push(finding('ComplexAndUntested', 'Critical', `FTA ${f.score.toFixed(1)} / cyclomatic ${f.cyclo} with ${cov}.`));
    }
    if (f.score > T.ftaSevere && f.cyclo >= 20) {
      out.push(finding('SevereComplexity', 'Critical', `FTA score ${f.score.toFixed(1)} is far above the ${T.ftaNeedsImprovement} "needs improvement" line (cyclomatic ${f.cyclo}).`));
    } else if (f.score > T.ftaNeedsImprovement && f.cyclo >= T.logicCyclo) {
      out.push(finding('NeedsImprovement', 'High', `FTA score ${f.score.toFixed(1)} (needs improvement), cyclomatic ${f.cyclo}.`));
    } else if (f.score > T.ftaCouldBeBetter && f.cyclo >= T.logicCyclo) {
      out.push(finding('CouldBeBetter', 'Medium', `FTA score ${f.score.toFixed(1)} (could be better), cyclomatic ${f.cyclo}.`));
    } else if (f.score > T.ftaCouldBeBetter) {
      out.push(finding('DataHeavy', 'Low', `FTA score ${f.score.toFixed(1)} but cyclomatic only ${f.cyclo}; likely tables/constants/setup code.`));
    }
    if (f.lineCount > T.fileLinesHuge) out.push(finding('HugeFile', 'High', `${f.lineCount} lines of code.`));
    else if (f.lineCount > T.fileLinesLarge) out.push(finding('LargeFile', 'Medium', `${f.lineCount} lines of code.`));
    if (f.cyclo > T.fileCycloHigh && f.score <= T.ftaNeedsImprovement) {
      out.push(finding('HighCyclomatic', 'Medium', `Cyclomatic complexity ${f.cyclo} across the file.`));
    }
  }

  if (hasCoverage) {
    const cyclo = f?.cyclo ?? null;
    const where = {
      'no-tests': 'The project has no tests.',
      'not-loaded': 'No test imports this file (it never appeared in the coverage data).',
    }[r.covState] ?? 'Tests load the file but execute none of its lines.';
    if (r.linePct === 0) {
      const sev = cyclo === null ? (logic ? 'High' : 'Medium') : cyclo >= 5 ? 'High' : cyclo >= 2 ? 'Medium' : 'Low';
      out.push(finding('NoCoverage', sev, where));
    } else if (r.linePct < T.coverageLow && (cyclo === null || cyclo >= 3)) {
      out.push(finding('LowCoverage', 'Medium', `${r.linePct.toFixed(1)}% line coverage.`));
    } else if (r.linePct < T.coverageTarget) {
      out.push(finding('PartialCoverage', 'Low', `${r.linePct.toFixed(1)}% line coverage (target ${T.coverageTarget}%).`));
    }
    if (r.coverage && r.linePct >= T.coverageLow && r.coverage.branches.total >= 4 && r.branchPct < T.coverageLow) {
      out.push(finding('LowBranchCoverage', 'Medium', `${r.branchPct.toFixed(1)}% branch coverage (${r.coverage.branches.covered}/${r.coverage.branches.total}).`));
    }
  }
  return dedupeCoverage(out);
}

// ComplexAndUntested already says the file is untested; keep NoCoverage/LowCoverage only as context.
function dedupeCoverage(list) {
  if (!list.some((f) => f.code === 'ComplexAndUntested')) return list;
  return list.filter((f) => !['NoCoverage', 'LowCoverage'].includes(f.code));
}

function functionHotspots(r) {
  const T = THRESHOLDS;
  if (!r.coverage) return [];
  const out = [];
  for (const fn of r.coverage.functions.list) {
    const findings = [];
    const stmtPct = pct(fn.statements.covered, fn.statements.total);
    if (fn.hits === 0 && fn.complexity >= T.fnComplex) {
      findings.push(finding('UntestedComplexFunction', fn.complexity >= T.fnVeryComplex ? 'Critical' : 'High',
        `Never executed by tests; approx. cyclomatic ${fn.complexity}.`));
    } else if (fn.complexity >= T.fnVeryComplex) {
      findings.push(finding('ComplexFunction', fn.complexity >= 30 ? 'High' : 'Medium', `Approx. cyclomatic ${fn.complexity}.`));
    }
    if (fn.hits > 0 && fn.complexity >= T.fnComplex && stmtPct !== null && stmtPct < T.coverageLow) {
      findings.push(finding('PoorlyTestedComplexFunction', 'Medium', `Only ${stmtPct.toFixed(0)}% of its statements run in tests; approx. cyclomatic ${fn.complexity}.`));
    }
    if (fn.length > T.fnVeryLong) findings.push(finding('LongFunction', 'High', `${fn.length} lines long.`));
    else if (fn.length > T.fnLong) findings.push(finding('LongFunction', 'Medium', `${fn.length} lines long.`));
    if (findings.length) {
      out.push({
        ...fn,
        displayName: displayName(fn.name),
        findings,
        severity: worst(findings),
        risk: crap(fn.complexity, stmtPct === null ? (fn.hits ? 1 : 0) : stmtPct / 100),
      });
    }
  }
  return out;
}

export function displayName(name) {
  if (!name || /^\(anonymous_\d+\)$/.test(name) || name === '(empty-report)') return 'anonymous function';
  return name;
}

/**
 * Flattens file- and function-level findings into one ranked hotspot list.
 * A file-level item carries the file's own findings; function items point at file:line.
 */
export function rankHotspots(files, projectFindings) {
  const items = [];
  for (const pf of projectFindings) items.push({ kind: 'project', target: '(project)', location: '', severity: pf.severity, findings: [pf], risk: Infinity });
  for (const r of files) {
    const own = r.findings.filter((f) => f.severity !== 'Low');
    if (own.length) {
      items.push({ kind: 'file', target: r.file, location: r.file, severity: worst(own), findings: own, risk: r.risk, record: r });
    }
    for (const fn of r.functions) {
      const important = fn.findings.filter((f) => f.severity !== 'Low');
      if (!important.length) continue;
      items.push({
        kind: 'function', target: `${fn.displayName}()`, location: `${r.file}:${fn.line}`,
        severity: worst(important), findings: important, risk: fn.risk, record: r, fn,
      });
    }
  }
  items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.risk - a.risk);
  return items;
}

export function projectFindings({ detection, testRun, coverageMode, sourcesCount, testsCount }) {
  const out = [];
  if (detection.runner.runner === 'none') {
    out.push(finding('NoTestRunner', 'Critical', `No test runner configured (${detection.runner.reason}); ${sourcesCount} source files have no test coverage at all.`));
  }
  if (testRun?.ran && (testRun.status === 'failed' || testRun.status === 'timed out')) {
    const c = testRun.counts;
    const detail = c ? `${c.failed} of ${c.total} tests failed` : `the test command exited with code ${testRun.exitCode}`;
    out.push(finding('TestsFailing', 'Critical', `${testRun.status === 'timed out' ? 'The test run timed out' : `Tests are failing: ${detail}`}. Coverage figures under-report until they pass.`));
  }
  if (coverageMode === 'failed') {
    out.push(finding('CoverageMissing', 'High', `The test run produced no coverage data${testsCount ? '' : ' (and no test files were found)'}.`));
  }
  return out;
}
