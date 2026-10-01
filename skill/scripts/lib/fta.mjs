import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IGNORED_DIRS, TEST_DIRS } from './files.mjs';
import { log, run, tail } from './util.mjs';

export const FTA_VERSION = '3.0.1';
const VENDOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'fta');

const TARGETS = {
  'darwin-arm64': 'fta-aarch64-apple-darwin',
  'darwin-x64': 'fta-x86_64-apple-darwin',
  'linux-x64': 'fta-x86_64-unknown-linux-musl',
  'linux-arm64': 'fta-aarch64-unknown-linux-musl',
  'linux-arm': 'fta-arm-unknown-linux-musleabi',
  'win32-x64': 'fta-x86_64-pc-windows-msvc',
  'win32-arm64': 'fta-aarch64-pc-windows-msvc',
};

// The FTA binary bundled by scripts/bundle.sh for this platform, or null.
export function bundledFtaBinary() {
  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) return null;
  const bin = path.join(VENDOR_DIR, target, process.platform === 'win32' ? 'fta.exe' : 'fta');
  return fs.existsSync(bin) ? bin : null;
}

const TEST_NAME_GLOBS = ['test', 'spec', 'e2e', 'cy', 'stories']
  .flatMap((k) => ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'].map((e) => `*.${k}.${e}`));

// Builds the fta.json used for the run. FTA appends list settings to its defaults, so these only add.
export function buildFtaConfig(userConfig) {
  const u = userConfig ?? {};
  return {
    ...u,
    extensions: [...new Set(['.mjs', '.cjs', '.mts', '.cts', ...(u.extensions ?? [])])],
    exclude_filenames: [...new Set([...TEST_NAME_GLOBS, ...(u.exclude_filenames ?? [])])],
    exclude_directories: [...new Set([...IGNORED_DIRS, ...TEST_DIRS, ...(u.exclude_directories ?? [])])],
    // The analyzer, not FTA, decides what counts as too big; never fail the run on score.
    score_cap: 100000,
  };
}

/**
 * Runs the bundled FTA binary over each source root and returns results keyed by absolute path.
 * FTA reports paths relative to the directory it was given.
 */
export async function runFta({ sourceRoots, userConfig, artifactsDir, ftaCommand, verbose }) {
  const configPath = path.join(artifactsDir, 'fta.json');
  fs.writeFileSync(configPath, JSON.stringify(buildFtaConfig(userConfig), null, 2));
  const results = new Map();
  const runs = [];
  const bundled = bundledFtaBinary();
  const base = ftaCommand ?? (bundled ? JSON.stringify(bundled) : null);
  if (!base) {
    const error = `No bundled FTA binary for ${process.platform}-${process.arch}. Run scripts/bundle.sh --all-platforms in the skill repository, or pass --fta-command.`;
    return { results, runs: sourceRoots.map((root) => ({ root, command: null, exitCode: null, files: 0, error })), configPath };
  }
  for (const root of sourceRoots) {
    const command = `${base} ${JSON.stringify(root)} --json -c ${JSON.stringify(configPath)}`;
    log(`running FTA: ${command}`);
    const res = await run(command, { cwd: root, timeoutMs: 10 * 60_000, verbose: false });
    const json = extractJsonArray(res.output);
    runs.push({ root, command, exitCode: res.code, files: json?.length ?? 0, error: json ? null : tail(res.output, 30) });
    if (verbose && !json) process.stderr.write(res.output);
    for (const f of json ?? []) {
      results.set(path.resolve(root, f.file_name), {
        score: f.fta_score,
        cyclo: f.cyclo,
        lineCount: f.line_count,
        assessment: String(f.assessment ?? '').replace(/[()]/g, ''),
        halstead: f.halstead,
      });
    }
  }
  return { results, runs, configPath };
}

// FTA may print warnings (e.g. parse fallbacks) around the JSON; take the outermost array.
export function extractJsonArray(output) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
