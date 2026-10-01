import fs from 'node:fs';
import path from 'node:path';
import { exists, readJson } from './util.mjs';

const DEFAULT_NPM_TEST = /no test specified/;

export function detectPackageManager(root) {
  const pkg = readJson(path.join(root, 'package.json')) ?? {};
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (declared && ['npm', 'yarn', 'pnpm', 'bun'].includes(declared)) return declared;
  // Walk up so a package inside a workspace uses the workspace's manager.
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (exists(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) return 'bun';
    if (exists(path.join(dir, 'package-lock.json'))) return 'npm';
    if (path.dirname(dir) === dir) return 'npm';
  }
}

export function addDevCommand(pm, spec, { workspaceRoot = false } = {}) {
  switch (pm) {
    case 'pnpm':
      return `pnpm add -D ${workspaceRoot ? '-w ' : ''}${spec}`;
    case 'yarn':
      return `yarn add -D ${workspaceRoot ? '-W ' : ''}${spec}`;
    case 'bun':
      return `bun add -d ${spec}`;
    default:
      return `npm install --save-dev ${spec}`;
  }
}

export function installCommand(pm) {
  return pm === 'npm' ? 'npm install' : `${pm} install`;
}

// Finds a package in node_modules, walking up for hoisted workspace installs.
export function resolveInstalled(root, name) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const pj = path.join(dir, 'node_modules', name, 'package.json');
    if (exists(pj)) return { dir: path.dirname(pj), version: readJson(pj)?.version ?? null };
    if (path.dirname(dir) === dir) return null;
  }
}

export function resolveBin(root, bin) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', '.bin', bin);
    if (exists(p)) return p;
    if (path.dirname(dir) === dir) return null;
  }
}

function allDeps(pkg) {
  return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
}

function hasConfig(root, prefix) {
  try {
    return fs.readdirSync(root).some((f) => f.startsWith(prefix));
  } catch {
    return false;
  }
}

// Works out which test runner the project uses and where that conclusion came from.
export function detectRunner(root, pkg, forced) {
  const script = pkg.scripts?.test && !DEFAULT_NPM_TEST.test(pkg.scripts.test) ? pkg.scripts.test : null;
  if (forced) return { runner: forced, reason: '--runner option', script };
  const deps = allDeps(pkg);
  if (script) {
    const checks = [
      ['vitest', /\bvitest\b/],
      ['jest', /\b(jest|react-scripts test|craco test)\b/],
      ['mocha', /\bmocha\b/],
      ['node-test', /\bnode\b[^&|;]*--test\b/],
      ['ava', /\bava\b/],
    ];
    for (const [runner, re] of checks) if (re.test(script)) return { runner, reason: `test script: \`${script}\``, script };
    // The script may delegate to another script (npm run test:unit) or a wrapper; fall through.
  }
  for (const runner of ['vitest', 'jest', 'mocha', 'ava']) {
    if (deps[runner]) return { runner, reason: `\`${runner}\` in dependencies`, script };
  }
  if (hasConfig(root, 'vitest.config') || hasConfig(root, 'vitest.workspace')) return { runner: 'vitest', reason: 'vitest config file', script };
  if (hasConfig(root, 'jest.config') || pkg.jest) return { runner: 'jest', reason: 'jest config', script };
  if (hasConfig(root, '.mocharc')) return { runner: 'mocha', reason: '.mocharc file', script };
  if (script) return { runner: 'other', reason: `unrecognised test script: \`${script}\``, script };
  return { runner: 'none', reason: 'no test script, test framework dependency or runner config found', script };
}

/**
 * Decides how coverage will be collected and whether anything has to be installed first.
 * Returns the plan plus the list of actions that need the user's permission.
 */
export function detectProject(root, options = {}) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJson(pkgPath);
  const warnings = [];
  if (!pkg) {
    return {
      root, hasPackageJson: false, pkg: {}, packageManager: null, runner: { runner: 'none', reason: 'no package.json' },
      coverage: { tool: null, installed: false, reason: 'no package.json, so no test runner to measure coverage with' },
      actions: [], warnings: ['No package.json found; only the complexity half of the analysis can run.'],
      typescript: exists(path.join(root, 'tsconfig.json')), nodeModules: false, workspaces: [],
    };
  }
  const pm = detectPackageManager(root);
  const deps = allDeps(pkg);
  const nodeModules = exists(path.join(root, 'node_modules')) || resolveInstalled(root, Object.keys(deps)[0] ?? '__none__') !== null;
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const isWorkspaceRoot = workspaces.length > 0 || exists(path.join(root, 'pnpm-workspace.yaml'));
  const runner = detectRunner(root, pkg, options.runner);
  const typescript = exists(path.join(root, 'tsconfig.json')) || Boolean(deps.typescript);

  const actions = [];
  if (Object.keys(deps).length && !nodeModules) {
    actions.push({ kind: 'install-deps', command: installCommand(pm), why: 'node_modules is missing, so the tests cannot run' });
  }

  const coverage = planCoverage({ root, pkg, deps, pm, runner: runner.runner, isWorkspaceRoot });
  if (coverage.install) {
    actions.push({ kind: 'add-coverage', command: coverage.install.command, package: coverage.install.spec, why: coverage.install.why });
  }
  if (isWorkspaceRoot && runner.runner === 'none') {
    warnings.push('This is a workspace root with no test runner of its own. Point the tool at an individual package, or add a root-level vitest/jest projects config.');
  }
  if (runner.runner === 'other') {
    warnings.push(`Test runner not recognised; coverage will wrap \`${pm} test\` with c8. Pass --runner or --test-command if that is wrong.`);
  }
  return {
    root, hasPackageJson: true, pkg, name: pkg.name ?? path.basename(root), packageManager: pm, nodeModules,
    workspaces, isWorkspaceRoot, typescript, runner, coverage, actions, warnings,
  };
}

function planCoverage({ root, deps, pm, runner, isWorkspaceRoot }) {
  if (runner === 'none') {
    return { tool: null, installed: false, reason: 'no test runner, so there is nothing to measure coverage with' };
  }
  if (runner === 'vitest') {
    const vitest = resolveInstalled(root, 'vitest');
    const version = vitest?.version ?? cleanRange(deps.vitest);
    for (const provider of ['v8', 'istanbul']) {
      const name = `@vitest/coverage-${provider}`;
      const inst = resolveInstalled(root, name);
      if (inst) {
        const mismatch = version && inst.version && major(inst.version) !== major(version);
        return {
          tool: name, provider, installed: true, version: inst.version,
          reason: mismatch ? `${name}@${inst.version} is installed but vitest is ${version}; coverage may fail` : `${name} is installed`,
        };
      }
      if (deps[name]) {
        return { tool: name, provider, installed: false, reason: `${name} is declared but not installed (run ${installCommand(pm)})` };
      }
    }
    const spec = version ? `@vitest/coverage-v8@${version}` : '@vitest/coverage-v8';
    return {
      tool: '@vitest/coverage-v8', provider: 'v8', installed: false,
      reason: 'vitest needs a coverage provider package and none is installed',
      install: { spec, command: addDevCommand(pm, spec, { workspaceRoot: isWorkspaceRoot }), why: 'Vitest cannot measure coverage without a provider; its version must match vitest.' },
    };
  }
  if (runner === 'jest') {
    return { tool: 'jest (built-in istanbul)', installed: true, reason: 'Jest collects coverage itself; nothing to install' };
  }
  return {
    tool: 'c8 (bundled)', installed: true,
    reason: `${runner === 'other' ? 'this test runner' : runner} has no built-in istanbul-format coverage; the skill's bundled c8 wraps the test command and reads V8 coverage`,
  };
}

function cleanRange(range) {
  if (!range) return null;
  const m = String(range).match(/\d+\.\d+\.\d+(-[\w.]+)?/);
  return m ? m[0] : null;
}

function major(v) {
  return String(v).split('.')[0];
}
