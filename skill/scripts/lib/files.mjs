import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, rel, toPosix } from './util.mjs';

export const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];

// Directories that never hold first-party source worth scoring.
export const IGNORED_DIRS = [
  'node_modules', 'dist', 'build', 'bin', 'out', 'coverage', '.nyc_output', '.git', '.next', '.nuxt',
  '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite', '.output', 'vendor', 'public', 'static',
  'storybook-static', 'tmp', 'temp',
];

// Directories whose contents are tests or test support.
export const TEST_DIRS = [
  '__tests__', '__test__', '__mocks__', '__fixtures__', 'test', 'tests', 'spec', 'specs', 'e2e',
  'cypress', 'playwright', 'fixtures', 'test-utils', 'testing',
];

const TEST_FILE_RE = /\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$/;
const NON_SOURCE_FILE_RES = [
  /\.d\.[cm]?ts$/,
  /\.min\.js$/,
  /\.bundle\.js$/,
  /\.stories\.[cm]?[jt]sx?$/,
  /(^|\.)config\.[cm]?[jt]s$/, // vite.config.ts, jest.config.js, eslint.config.mjs …
  /^\..*rc\.[cm]?js$/, // .eslintrc.js, .prettierrc.cjs
  /^(setupTests|test-setup|vitest\.setup|jest\.setup)\.[cm]?[jt]sx?$/,
];

export function isSourceExtension(file) {
  return SOURCE_EXTENSIONS.includes(path.extname(file));
}

export function isTestFile(relPath) {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1];
  if (TEST_FILE_RE.test(name)) return true;
  return parts.slice(0, -1).some((d) => TEST_DIRS.includes(d));
}

// FTA-style glob: matched against the file name; ".foo" without wildcards means suffix.
export function globToRegExp(glob) {
  if (glob.startsWith('.') && !/[*?]/.test(glob)) {
    return new RegExp(`${escapeRe(glob)}$`);
  }
  const body = glob.split('').map((c) => (c === '*' ? '[^/]*' : c === '?' ? '.' : escapeRe(c))).join('');
  return new RegExp(`^${body}$`);
}

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// Lists candidate files under root: git-tracked + untracked-not-ignored when root is in a git
// work tree, otherwise a plain walk that skips IGNORED_DIRS.
export function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
    const files = out.split('\0').filter(Boolean).map((f) => path.join(root, f));
    return { files: files.filter((f) => fs.existsSync(f)), viaGit: true };
  } catch {
    const files = [];
    walk(root, files);
    return { files, viaGit: false };
  }
}

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.includes(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), acc);
    } else if (e.isFile()) {
      acc.push(path.join(dir, e.name));
    }
  }
}

// Picks the directories to analyse: explicit --src, else ./src when present, else the project root.
export function resolveSourceRoots(projectRoot, srcOption) {
  if (srcOption.length) return srcOption.map((s) => path.resolve(projectRoot, s));
  const src = path.join(projectRoot, 'src');
  if (fs.existsSync(src) && fs.statSync(src).isDirectory()) return [src];
  return [projectRoot];
}

// Output directories declared by tsconfig (outDir) or package.json (main/module under lib/ etc.).
export function buildOutputDirs(projectRoot) {
  const dirs = new Set();
  const tsconfig = readJsonc(path.join(projectRoot, 'tsconfig.json'));
  const outDir = tsconfig?.compilerOptions?.outDir;
  if (outDir) dirs.add(toPosix(path.normalize(outDir)).replace(/^\.\//, '').replace(/\/$/, ''));
  return [...dirs];
}

function readJsonc(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
      .replace(/("(?:\\.|[^"\\])*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Reads a user fta.json from the project root or the first source root, if any.
export function loadUserFtaConfig(projectRoot, sourceRoots) {
  for (const dir of [sourceRoots[0], projectRoot]) {
    const file = path.join(dir, 'fta.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    if (cfg) return { file, config: cfg };
  }
  return null;
}

/**
 * Classifies every file in the project into production source (inside a source root, not a test,
 * not config/generated) and test files (anywhere in the project).
 */
export function discoverFiles({ projectRoot, sourceRoots, extraExcludeDirs = [], extraExcludeFiles = [] }) {
  const { files, viaGit } = listFiles(projectRoot);
  const outDirs = buildOutputDirs(projectRoot);
  const excludeDirSegments = [...IGNORED_DIRS, ...extraExcludeDirs.map((d) => d.replace(/^\/+|\/+$/g, ''))];
  const excludeFileRes = extraExcludeFiles.map(globToRegExp);

  const sources = [];
  const tests = [];
  for (const abs of files) {
    if (!isSourceExtension(abs)) continue;
    const r = rel(projectRoot, abs);
    if (r.startsWith('..')) continue;
    const parts = r.split('/');
    const dirParts = parts.slice(0, -1);
    const name = parts[parts.length - 1];
    if (dirParts.some((d) => IGNORED_DIRS.includes(d))) continue;
    if (isTestFile(r)) {
      tests.push(abs);
      continue;
    }
    if (!sourceRoots.some((s) => abs === s || abs.startsWith(s + path.sep))) continue;
    if (outDirs.some((o) => r === o || r.startsWith(o + '/'))) continue;
    if (dirParts.some((d) => d.startsWith('.'))) continue;
    if (matchesDirSegments(dirParts, excludeDirSegments)) continue;
    if (NON_SOURCE_FILE_RES.some((re) => re.test(name))) continue;
    if (excludeFileRes.some((re) => re.test(name))) continue;
    if (isGenerated(abs)) continue;
    sources.push(abs);
  }
  return { sources: sources.sort(), tests: tests.sort(), viaGit, outDirs };
}

function matchesDirSegments(dirParts, patterns) {
  return patterns.some((p) => {
    const seg = p.split('/').filter(Boolean);
    for (let i = 0; i + seg.length <= dirParts.length; i++) {
      if (seg.every((s, j) => dirParts[i + j] === s)) return true;
    }
    return false;
  });
}

function isGenerated(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(400);
    const n = fs.readSync(fd, buf, 0, 400, 0);
    fs.closeSync(fd);
    return /@generated|auto-generated|do not edit/i.test(buf.toString('utf8', 0, n));
  } catch {
    return false;
  }
}

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+|(?:vi|jest)\.mock\s*\(\s*)['"`]([^'"`]+)['"`]/g;

function stem(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return base.replace(/\.(test|spec|e2e|cy)$/, '');
}

function resolveImport(fromFile, spec, sourceSet) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const noJsExt = base.replace(/\.(m|c)?js$/, '');
  const candidates = [base];
  for (const b of [base, noJsExt]) {
    for (const ext of SOURCE_EXTENSIONS) {
      candidates.push(b + ext, path.join(b, 'index' + ext));
    }
  }
  return candidates.find((c) => sourceSet.has(c)) ?? null;
}

/**
 * Maps each source file to the test files that reference it, either by a relative import or by
 * sharing its name (foo.ts <-> foo.test.ts, index.ts <-> <dir>.test.ts).
 */
export function mapTestsToSources(sources, tests) {
  const sourceSet = new Set(sources);
  const byStem = new Map();
  for (const s of sources) {
    const keys = [stem(s)];
    if (stem(s) === 'index') keys.push(path.basename(path.dirname(s)));
    for (const k of keys) {
      if (!byStem.has(k)) byStem.set(k, []);
      byStem.get(k).push(s);
    }
  }
  const map = new Map(sources.map((s) => [s, new Set()]));
  for (const t of tests) {
    for (const s of byStem.get(stem(t)) ?? []) map.get(s).add(t);
    let text = '';
    try {
      text = fs.readFileSync(t, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveImport(t, m[1], sourceSet);
      if (target) map.get(target).add(t);
    }
  }
  return map;
}

// Describes where the project keeps its tests so a fixing agent can follow the same layout.
export function detectTestLayout(projectRoot, tests) {
  if (!tests.length) return { style: 'none', example: null };
  const counts = { colocated: 0, '__tests__': 0, 'separate dir': 0 };
  for (const t of tests) {
    const r = rel(projectRoot, t);
    if (r.split('/').includes('__tests__')) counts['__tests__']++;
    else if (r.split('/').some((d) => TEST_DIRS.includes(d))) counts['separate dir']++;
    else counts.colocated++;
  }
  const style = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const ext = new Map();
  for (const t of tests) {
    const m = path.basename(t).match(/\.(test|spec)\.[cm]?[jt]sx?$/);
    if (m) ext.set(m[0], (ext.get(m[0]) ?? 0) + 1);
  }
  const suffix = [...ext.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '.test.js';
  return { style, suffix, example: rel(projectRoot, tests[0]) };
}
