// End-to-end runs of analyze.mjs against fixtures that need no package installs:
// a project without tests, and a node:test project covered by the bundled c8.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANALYZE = path.join(HERE, '..', 'skill', 'scripts', 'analyze.mjs');

function copyFixture(name) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `jsca-e2e-${name}-`));
  fs.cpSync(path.join(HERE, 'fixtures', name), dest, { recursive: true });
  return dest;
}

function analyze(dir, ...args) {
  const out = execFileSync(process.execPath, [ANALYZE, dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const summary = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1));
  return { summary, report: fs.readFileSync(path.join(dir, 'CODE_ANALYSIS_REPORT.md'), 'utf8') };
}

describe('analyze.mjs end to end', () => {
  it('reports a project with no tests', () => {
    const dir = copyFixture('no-tests');
    const { summary, report } = analyze(dir);
    assert.equal(summary.testRunner, 'none');
    assert.equal(summary.complexity.filesScored, 3);
    assert.ok(summary.hotspots.critical >= 2);
    assert.match(report, /NoTestRunner/);
    assert.match(report, /`src\/pricing\.js` \| Critical|\| Critical \| src\/pricing\.js/);
  });

  it('measures node:test coverage with the bundled c8 and installs nothing', () => {
    const dir = copyFixture('node-test');
    const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const { summary, report } = analyze(dir);
    assert.equal(summary.tests.status, 'passed');
    assert.equal(summary.tests.passed, 1);
    assert.equal(summary.coverage.filesNeverLoadedByTests, 2);
    assert.deepEqual(summary.modifications, []);
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(dir, 'coverage')), 'coverage output must not land in the project');
    assert.match(report, /formatMoney/);
  });

  it('refuses to install without --install and exits 3', () => {
    const dir = copyFixture('mocha-js');
    const res = spawnSync(process.execPath, [ANALYZE, dir], { encoding: 'utf8' });
    assert.equal(res.status, 3);
    assert.match(res.stderr, /npm install/);
    assert.ok(!fs.existsSync(path.join(dir, 'CODE_ANALYSIS_REPORT.md')));
  });

  it('--check changes nothing', () => {
    const dir = copyFixture('vitest-ts');
    const out = execFileSync(process.execPath, [ANALYZE, dir, '--check'], { encoding: 'utf8' });
    assert.match(out, /@vitest\/coverage-v8/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['package.json', 'src']);
  });
});
