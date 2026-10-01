import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function exists(p) {
  return fs.existsSync(p);
}

export function log(msg) {
  process.stderr.write(`[js-code-analysis] ${msg}\n`);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function rel(root, file) {
  return toPosix(path.relative(root, file));
}

export function pct(covered, total) {
  return total === 0 ? null : (covered / total) * 100;
}

export function fmtPct(v) {
  return v === null || v === undefined ? 'n/a' : `${v.toFixed(1)}%`;
}

export function fmtNum(v, digits = 1) {
  return v === null || v === undefined ? 'n/a' : Number(v).toFixed(digits);
}

// Collapses a sorted list of line numbers into "3-7, 12, 20-21".
export function lineRanges(lines, limit = 12) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const text = ranges.slice(0, limit).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  if (ranges.length > limit) text.push(`… ${ranges.length - limit} more`);
  return text.join(', ');
}

export function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Runs a shell command, capturing combined output. Streams it to stderr when verbose.
export function run(command, { cwd, env, timeoutMs, verbose } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A parent node:test run would capture a nested `node --test` through NODE_TEST_CONTEXT.
    const { NODE_TEST_CONTEXT, ...baseEnv } = process.env;
    const child = spawn(command, {
      cwd,
      env: { ...baseEnv, ...env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const onData = (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
      if (verbose) process.stderr.write(chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? null : code, timedOut, output, durationMs: Date.now() - started });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, timedOut, output: output + String(err), durationMs: Date.now() - started });
    });
  });
}

export function tail(text, lines = 60) {
  // Strip ANSI colour codes so the tail is readable in markdown.
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  return clean.split('\n').slice(-lines).join('\n').trim();
}
