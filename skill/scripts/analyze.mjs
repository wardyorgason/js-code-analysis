#!/usr/bin/env node
// JS/TS code analysis: FTA complexity + unit test coverage -> CODE_ANALYSIS_REPORT.md.
// Run with --help for options. Needs only Node 18+; FTA and c8 are bundled in ../vendor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexCoverage, runTests } from './lib/coverage.mjs';
import { detectProject } from './lib/detect.mjs';
import { detectTestLayout, discoverFiles, loadUserFtaConfig, mapTestsToSources, resolveSourceRoots } from './lib/files.mjs';
import { analyseFiles, projectFindings, rankHotspots } from './lib/findings.mjs';
import { FTA_VERSION, runFta } from './lib/fta.mjs';
import { buildSummary, renderReport } from './lib/report.mjs';
import { log, run, tail } from './lib/util.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_NEEDS_PERMISSION = 3;

const HELP = `Usage: analyze.mjs [project-dir] [options]

Analyses a JavaScript/TypeScript project with FTA (complexity) and the project's own test runner
(coverage), then writes CODE_ANALYSIS_REPORT.md into the project directory.

  --check                 Detect runner/coverage setup and print what would be installed; change nothing
  --install               Allow installing what --check listed (node_modules, coverage package)
  --skip-tests            Complexity only; do not run tests
  --src <dir>             Source directory to analyse (repeatable; default ./src, else the project root)
  --runner <name>         Override runner detection: vitest | jest | mocha | node-test | ava | other
  --test-command "<cmd>"  Command that runs the tests (coverage flags are appended, or c8 wraps it)
  --test-args "<args>"    Extra arguments appended to the test command
  --test-timeout <min>    Test run timeout in minutes (default 30)
  -o, --output <file>     Report path (default <project>/CODE_ANALYSIS_REPORT.md)
  --max-details <n>       Hotspots given a detail section (default 25)
  --guidelines <file>     Remediation guidelines embedded in Section 3
  --fta-command "<cmd>"   How to invoke FTA (default: the bundled fta ${FTA_VERSION} binary)
  --keep-artifacts        Keep coverage JSON, test output and fta.json
  --artifacts-dir <dir>   Where to put artifacts (implies --keep-artifacts)
  -v, --verbose           Stream test output to stderr

Exit codes: 0 report written (even if tests failed), 2 usage/environment error,
            3 something must be installed first and --install was not given.`;

function parseArgs(argv) {
  const o = { src: [], testTimeout: 30, maxDetails: 25 };
  const need = (i) => {
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--check': o.check = true; break;
      case '--install': o.install = true; break;
      case '--skip-tests': o.skipTests = true; break;
      case '--src': o.src.push(need(i)); i++; break;
      case '--runner': o.runner = need(i); i++; break;
      case '--test-command': o.testCommand = need(i); i++; break;
      case '--test-args': o.testArgs = need(i); i++; break;
      case '--test-timeout': o.testTimeout = Number(need(i)); i++; break;
      case '-o': case '--output': o.output = need(i); i++; break;
      case '--max-details': o.maxDetails = Number(need(i)); i++; break;
      case '--guidelines': o.guidelines = need(i); i++; break;
      case '--fta-command': o.ftaCommand = need(i); i++; break;
      case '--keep-artifacts': o.keepArtifacts = true; break;
      case '--artifacts-dir': o.artifactsDir = need(i); o.keepArtifacts = true; i++; break;
      case '-v': case '--verbose': o.verbose = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
        if (o.project) throw new Error(`Unexpected argument ${a}`);
        o.project = a;
    }
  }
  const runners = ['vitest', 'jest', 'mocha', 'node-test', 'ava', 'other'];
  if (o.runner && !runners.includes(o.runner)) throw new Error(`--runner must be one of ${runners.join(', ')}`);
  return o;
}

function planText(d) {
  const lines = [
    `Project:         ${d.name ?? d.root}`,
    `Package manager: ${d.packageManager ?? 'n/a'}`,
    `Test runner:     ${d.runner.runner} (${d.runner.reason})`,
    `Coverage tool:   ${d.coverage.tool ?? 'none'} (${d.coverage.reason})`,
  ];
  if (d.actions.length) {
    lines.push('', 'Before tests can run with coverage, these commands must run in the project (needs --install):');
    for (const a of d.actions) lines.push(`  ${a.command}    # ${a.why}`);
  } else {
    lines.push('', 'Nothing needs to be installed.');
  }
  for (const w of d.warnings) lines.push(`Warning: ${w}`);
  lines.push(`FTA ${FTA_VERSION} and c8 are bundled with the skill; neither is added to the project.`);
  return lines.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  let root = path.resolve(opts.project ?? '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    return 2;
  }
  // Coverage tools report real paths; match them (macOS /var -> /private/var, symlinked checkouts).
  root = fs.realpathSync(root);

  let detection = detectProject(root, { runner: opts.runner });
  const wantsTests = !opts.skipTests && detection.runner.runner !== 'none';
  const pendingActions = wantsTests ? detection.actions : [];

  if (opts.check) {
    console.log(planText({ ...detection, actions: pendingActions }));
    console.log('\n' + JSON.stringify({
      runner: detection.runner.runner,
      coverageTool: detection.coverage.tool,
      coverageInstalled: detection.coverage.installed,
      actions: pendingActions,
      warnings: detection.warnings,
    }, null, 2));
    return 0;
  }
  if (pendingActions.length && !opts.install) {
    console.error(planText({ ...detection, actions: pendingActions }));
    console.error('\nNot installing anything without --install. Re-run with --install, or with --skip-tests for a complexity-only report.');
    return EXIT_NEEDS_PERMISSION;
  }

  const modifications = [];
  const warnings = [...detection.warnings];
  const perform = async (action) => {
    log(`installing: ${action.command}`);
    const res = await run(action.command, { cwd: root, timeoutMs: 15 * 60_000, verbose: opts.verbose });
    modifications.push({ ...action, ok: res.code === 0 });
    if (res.code !== 0) warnings.push(`\`${action.command}\` failed:\n\n\`\`\`\n${tail(res.output, 20)}\n\`\`\``);
  };
  // Install dependencies first, then re-detect: the coverage package must match the installed runner version.
  for (const action of pendingActions.filter((a) => a.kind === 'install-deps')) await perform(action);
  if (modifications.length) detection = detectProject(root, { runner: opts.runner });
  if (wantsTests) for (const action of detection.actions.filter((a) => a.kind === 'add-coverage')) await perform(action);
  if (modifications.length) detection = detectProject(root, { runner: opts.runner });

  const sourceRoots = resolveSourceRoots(root, opts.src);
  const userFtaConfig = loadUserFtaConfig(root, sourceRoots);
  const { sources, tests, viaGit } = discoverFiles({
    projectRoot: root,
    sourceRoots,
    extraExcludeDirs: userFtaConfig?.config.exclude_directories ?? [],
    extraExcludeFiles: userFtaConfig?.config.exclude_filenames ?? [],
  });
  log(`${sources.length} source files, ${tests.length} test files`);
  if (!sources.length) warnings.push('No source files found. Use --src to point at the source directory.');
  if (wantsTests && !tests.length) warnings.push('A test runner is configured but no test files were found.');
  if (!viaGit) warnings.push('Not a git work tree, so .gitignore was not applied; common build and vendor directories were skipped by name.');

  const artifactsDir = opts.artifactsDir
    ? path.resolve(opts.artifactsDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'js-code-analysis-'));
  fs.mkdirSync(artifactsDir, { recursive: true });

  const [ftaRun, testRun] = await Promise.all([
    runFta({ sourceRoots, userConfig: userFtaConfig?.config, artifactsDir, ftaCommand: opts.ftaCommand, verbose: opts.verbose }),
    wantsTests
      ? runTests({ detection, artifactsDir, testCommand: opts.testCommand, testArgs: opts.testArgs, timeoutMinutes: opts.testTimeout, verbose: opts.verbose })
      : Promise.resolve(null),
  ]);
  for (const r of ftaRun.runs) if (r.error) warnings.push(`FTA failed on \`${path.relative(root, r.root) || '.'}\`; complexity data is missing (see Appendix).`);
  if (testRun) warnings.push(...testRun.notes);

  const coverageMode = opts.skipTests
    ? 'skipped'
    : detection.runner.runner === 'none'
      ? 'none'
      : testRun?.coverage
        ? 'measured'
        : 'failed';

  const files = analyseFiles({
    projectRoot: root,
    sources,
    fta: ftaRun.results,
    coverageByFile: testRun?.coverage ? indexCoverage(testRun.coverage, root) : null,
    coverageMode,
    testMap: mapTestsToSources(sources, tests),
  });
  const pFindings = projectFindings({ detection, testRun, coverageMode, sourcesCount: sources.length, testsCount: tests.length });
  const hotspots = rankHotspots(files, pFindings);
  const guidelinesFile = opts.guidelines ?? path.join(SKILL_DIR, 'references', 'remediation-guidelines.md');
  const guidelines = fs.existsSync(guidelinesFile) ? fs.readFileSync(guidelinesFile, 'utf8') : '_Guidelines file not found._';

  const ctx = {
    detection, files, hotspots, testRun, coverageMode, modifications, warnings, guidelines,
    sourceRoots, userFtaConfig, viaGit, testsCount: tests.length, layout: detectTestLayout(root, tests),
    generatedAt: new Date().toISOString(), commandLine: ['analyze.mjs', ...process.argv.slice(2)].join(' '),
    ftaVersion: FTA_VERSION, ftaRuns: ftaRun.runs, artifactsDir, artifactsKept: Boolean(opts.keepArtifacts),
    maxDetails: opts.maxDetails,
  };
  ctx.summary = buildSummary(ctx);
  const reportPath = path.resolve(opts.output ?? path.join(root, 'CODE_ANALYSIS_REPORT.md'));
  fs.writeFileSync(reportPath, renderReport(ctx));
  if (!opts.keepArtifacts) fs.rmSync(artifactsDir, { recursive: true, force: true });

  console.log(JSON.stringify(ctx.summary, null, 2));
  console.log(`\nReport written to ${reportPath}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.stack ?? String(err));
    process.exit(2);
  },
);
