import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin } from './detect.mjs';
import { log, readJson, run, tail } from './util.mjs';

const BUNDLED_C8 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'c8', 'node_modules', 'c8', 'bin', 'c8.js');

// ---------------------------------------------------------------------------
// Building the test command
// ---------------------------------------------------------------------------

/**
 * Splits a simple package.json test script ("NODE_OPTIONS=x cross-env A=1 vitest run --dir src")
 * into env assignments, the runner and its arguments. Returns null for anything with shell
 * control operators, where appending coverage flags would be guesswork.
 */
export function parseTestScript(script, runnerBin) {
  if (!script || /&&|\|\||[;|<>`$(]/.test(script)) return null;
  const tokens = script.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const env = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'cross-env' || t === 'npx' || t === 'dotenv' || t === '--') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) env.push(t);
    else break;
  }
  const bin = tokens[i];
  if (!bin || path.basename(bin) !== runnerBin) return null;
  return { env, args: tokens.slice(i + 1) };
}

const VITEST_DROP = new Set(['watch', 'dev', 'run', '--watch', '-w', '--run', '--coverage', '--ui']);
const JEST_DROP = new Set(['--watch', '--watchAll', '--coverage']);

export function buildTestCommand({ detection, artifactsDir, testCommand, testArgs = '' }) {
  const { root, runner, packageManager: pm } = detection;
  const covDir = path.join(artifactsDir, 'coverage');
  const resultsFile = path.join(artifactsDir, 'test-results.json');
  const q = (p) => JSON.stringify(p);
  const notes = [];

  if (runner.runner === 'vitest' || runner.runner === 'jest') {
    const isVitest = runner.runner === 'vitest';
    const binName = isVitest ? 'vitest' : 'jest';
    let base;
    if (testCommand) {
      base = testCommand;
    } else {
      const bin = resolveBin(root, binName);
      if (!bin) return { error: `Could not find node_modules/.bin/${binName}; install dependencies first.` };
      const parsed = parseTestScript(runner.script, binName);
      if (runner.script && !parsed) {
        notes.push(`The test script \`${runner.script}\` is not a plain \`${binName}\` call, so ${binName} was run directly without its arguments. Use --test-command if that misses required setup.`);
      }
      const drop = isVitest ? VITEST_DROP : JEST_DROP;
      const args = (parsed?.args ?? []).filter((a) => !drop.has(a) && !/^--(watch|coverage)/.test(a));
      base = [...(parsed?.env ?? []), q(bin), isVitest ? 'run' : '', ...args].filter(Boolean).join(' ');
    }
    const flags = isVitest
      ? [
          '--coverage.enabled=true',
          `--coverage.provider=${detection.coverage.provider ?? 'v8'}`,
          '--coverage.reporter=json',
          '--coverage.reporter=json-summary',
          `--coverage.reportsDirectory=${q(covDir)}`,
          '--coverage.reportOnFailure=true',
          '--reporter=default',
          '--reporter=json',
          `--outputFile.json=${q(resultsFile)}`,
        ]
      : [
          '--ci',
          '--watchAll=false',
          '--coverage',
          '--coverageReporters=json',
          '--coverageReporters=json-summary',
          `--coverageDirectory=${q(covDir)}`,
          '--json',
          `--outputFile=${q(resultsFile)}`,
        ];
    return { command: [base, ...flags, testArgs].filter(Boolean).join(' '), covDir, resultsFile, format: 'jest-json', notes };
  }

  // Everything else: wrap the test command with c8, which reads V8 coverage from child processes.
  if (!fs.existsSync(BUNDLED_C8)) return { error: `Bundled c8 missing at ${BUNDLED_C8}; run scripts/bundle.sh in the skill repository.` };
  let inner = testCommand;
  if (!inner) {
    if (runner.script) inner = pm === 'bun' ? 'bun run test' : `${pm} test`;
    else {
      const bin = resolveBin(root, runner.runner === 'node-test' ? 'node' : runner.runner);
      inner = runner.runner === 'node-test' ? 'node --test' : bin ? q(bin) : null;
    }
  }
  if (!inner) return { error: `No way to run the ${runner.runner} tests was found; pass --test-command.` };
  const command = [
    q(process.execPath), q(BUNDLED_C8), '--reporter=json', '--reporter=json-summary', `--report-dir=${q(covDir)}`,
    `--temp-directory=${q(path.join(artifactsDir, 'c8-tmp'))}`, '--exclude-after-remap', inner, testArgs,
  ].filter(Boolean).join(' ');
  return { command, covDir, resultsFile: null, format: 'text', notes };
}

// ---------------------------------------------------------------------------
// Running and parsing
// ---------------------------------------------------------------------------

export async function runTests({ detection, artifactsDir, testCommand, testArgs, timeoutMinutes, verbose }) {
  const built = buildTestCommand({ detection, artifactsDir, testCommand, testArgs });
  if (built.error) return { ran: false, error: built.error, notes: [] };
  log(`running tests with coverage: ${built.command}`);
  const res = await run(built.command, {
    cwd: detection.root,
    env: { CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
    timeoutMs: timeoutMinutes * 60_000,
    verbose,
  });
  fs.writeFileSync(path.join(artifactsDir, 'test-output.log'), res.output);
  const results = built.format === 'jest-json' ? parseJestJson(built.resultsFile) : null;
  const counts = results?.counts ?? parseTextCounts(res.output);
  const coverageFile = path.join(built.covDir, 'coverage-final.json');
  const coverage = fs.existsSync(coverageFile) ? readJson(coverageFile) : null;
  const status = res.timedOut
    ? 'timed out'
    : counts && counts.failed > 0
      ? 'failed'
      : results?.suiteErrors?.length
        ? 'failed'
        : counts
          ? res.code === 0 ? 'passed' : 'passed (non-zero exit, probably coverage thresholds)'
          : res.code === 0 ? 'passed' : 'failed';
  return {
    ran: true,
    command: built.command,
    exitCode: res.code,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    status,
    counts,
    failures: results?.failures ?? [],
    suiteErrors: results?.suiteErrors ?? [],
    outputTail: tail(res.output, 80),
    coverage,
    notes: built.notes,
  };
}

export function parseJestJson(file) {
  const data = file && fs.existsSync(file) ? readJson(file) : null;
  if (!data) return null;
  const counts = {
    total: data.numTotalTests ?? 0,
    passed: data.numPassedTests ?? 0,
    failed: data.numFailedTests ?? 0,
    skipped: (data.numPendingTests ?? 0) + (data.numTodoTests ?? 0),
    suites: data.numTotalTestSuites ?? (data.testResults?.length ?? 0),
    failedSuites: data.numFailedTestSuites ?? 0,
  };
  const failures = [];
  const suiteErrors = [];
  for (const suite of data.testResults ?? []) {
    const assertions = suite.assertionResults ?? [];
    for (const a of assertions) {
      if (a.status === 'failed') {
        failures.push({
          file: suite.name,
          name: a.fullName ?? a.title,
          message: firstLines((a.failureMessages ?? []).join('\n'), 6),
        });
      }
    }
    if (suite.status === 'failed' && !assertions.some((a) => a.status === 'failed') && suite.message) {
      suiteErrors.push({ file: suite.name, message: firstLines(suite.message, 10) });
    }
  }
  return { counts, failures, suiteErrors };
}

function firstLines(text, n) {
  return tail(text.split('\n').slice(0, n).join('\n'), n);
}

// Best-effort pass/fail counts from mocha, node:test, ava and tap output.
export function parseTextCounts(output) {
  const text = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const num = (re) => {
    const m = [...text.matchAll(re)].pop();
    return m ? Number(m[1]) : null;
  };
  const patterns = [
    { passed: /(\d+) passing/g, failed: /(\d+) failing/g, skipped: /(\d+) pending/g },
    { passed: /^[ℹ#] pass (\d+)/gm, failed: /^[ℹ#] fail (\d+)/gm, skipped: /^[ℹ#] skipped (\d+)/gm },
    { passed: /(\d+) tests? passed/g, failed: /(\d+) tests? failed/g, skipped: /(\d+) tests? skipped/g },
  ];
  for (const p of patterns) {
    const passed = num(p.passed);
    if (passed === null) continue;
    const failed = num(p.failed) ?? 0;
    const skipped = num(p.skipped) ?? 0;
    return { total: passed + failed + skipped, passed, failed, skipped, suites: null, failedSuites: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Istanbul coverage-final.json -> per-file and per-function figures
// ---------------------------------------------------------------------------

function contains(outer, inner) {
  const s = outer.start;
  const e = outer.end;
  const a = inner.start;
  const after = a.line > s.line || (a.line === s.line && (a.column ?? 0) >= (s.column ?? 0));
  const before = a.line < e.line || (a.line === e.line && (a.column ?? 0) <= (e.column ?? Infinity));
  return after && before;
}

function span(loc) {
  return (loc.end.line - loc.start.line) * 10_000 + ((loc.end.column ?? 0) - (loc.start.column ?? 0));
}

/**
 * Summarises one istanbul FileCoverage object. Functions get their own statement/branch counts by
 * assigning every statement and branch to the innermost function that contains it, which gives an
 * approximate per-function cyclomatic complexity (1 + decision points).
 */
export function summariseFileCoverage(fc) {
  const lineHits = new Map();
  if (fc.l) {
    for (const [line, hits] of Object.entries(fc.l)) lineHits.set(Number(line), hits);
  } else {
    for (const [id, loc] of Object.entries(fc.statementMap ?? {})) {
      const line = loc.start.line;
      const hits = fc.s?.[id] ?? 0;
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
    }
  }
  const lines = { total: lineHits.size, covered: [...lineHits.values()].filter((h) => h > 0).length };
  const uncoveredLines = [...lineHits.entries()].filter(([, h]) => h === 0).map(([l]) => l);

  const stmtIds = Object.keys(fc.statementMap ?? {});
  const statements = { total: stmtIds.length, covered: stmtIds.filter((id) => (fc.s?.[id] ?? 0) > 0).length };

  const branchEntries = Object.entries(fc.branchMap ?? {});
  const singleArm = branchEntries.length > 0 && branchEntries.every(([, b]) => (b.locations?.length ?? 0) <= 1);
  let branchTotal = 0;
  let branchCovered = 0;
  for (const [id] of branchEntries) {
    const counts = fc.b?.[id] ?? [];
    branchTotal += counts.length;
    branchCovered += counts.filter((c) => c > 0).length;
  }
  const branches = { total: branchTotal, covered: branchCovered };

  const fns = Object.entries(fc.fnMap ?? {})
    .map(([id, fn]) => ({
      id,
      name: fn.name,
      loc: fn.loc ?? fn.decl,
      line: (fn.decl ?? fn.loc).start.line,
      hits: fc.f?.[id] ?? 0,
      statements: { total: 0, covered: 0 },
      decisions: 0,
    }))
    .filter((f) => f.loc);
  const innermost = (loc) => {
    let best = null;
    for (const f of fns) if (contains(f.loc, loc) && (!best || span(f.loc) < span(best.loc))) best = f;
    return best;
  };
  for (const id of stmtIds) {
    const f = innermost(fc.statementMap[id]);
    if (!f) continue;
    f.statements.total++;
    if ((fc.s?.[id] ?? 0) > 0) f.statements.covered++;
  }
  for (const [, b] of branchEntries) {
    const f = innermost(b.loc ?? b.locations?.[0]);
    if (!f) continue;
    // Istanbul records an if/else as one branch with two arms (one decision). V8-derived data
    // records one entry per block, so each entry counts as one decision there.
    f.decisions += singleArm ? 1 : Math.max(1, (b.locations?.length ?? 2) - 1);
  }
  const functions = {
    total: fns.length,
    covered: fns.filter((f) => f.hits > 0).length,
    list: fns.map((f) => ({
      name: f.name,
      line: f.line,
      endLine: f.loc.end.line,
      length: f.loc.end.line - f.loc.start.line + 1,
      hits: f.hits,
      complexity: 1 + f.decisions,
      statements: f.statements,
    })),
  };
  return { lines, statements, branches, functions, uncoveredLines, branchSource: singleArm ? 'v8-blocks' : 'istanbul' };
}

export function indexCoverage(coverage, root) {
  const byFile = new Map();
  for (const [key, fc] of Object.entries(coverage ?? {})) {
    const abs = path.resolve(root, fc.path ?? key);
    byFile.set(abs, fc);
  }
  return byFile;
}
