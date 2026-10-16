/**
 * Real-environment integration test.
 *
 * Unlike the rest of the suite, this one really builds with `xcodebuild`, really talks
 * to `simctl`, and cross-checks the plugin's diagnostic counts against the raw log —
 * the check that matters, because a parser that drops a real warning reports a clean
 * run and nothing else notices.
 *
 * It is opt-in, since it needs Xcode, a booted simulator and several minutes:
 *
 *     IOS_HELPER_INTEGRATION=1 \
 *     IOS_HELPER_INTEGRATION_ROOT=/path/to/project \
 *     IOS_HELPER_INTEGRATION_SIMULATOR='iPhone 17 Pro' \
 *     IOS_HELPER_INTEGRATION_BUNDLE_ID=com.example.app \
 *       node --test test/integration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { makeContext } from './support/harness.mjs';
import { makeRealSubprocess } from './support/real-subprocess.mjs';

const enabled = process.env.IOS_HELPER_INTEGRATION === '1';
const skip = enabled ? false : 'set IOS_HELPER_INTEGRATION=1 to run the real-environment tests';
const root = process.env.IOS_HELPER_INTEGRATION_ROOT ?? process.cwd();
const simulator = process.env.IOS_HELPER_INTEGRATION_SIMULATOR ?? 'iPhone 17 Pro';
const os = process.env.IOS_HELPER_INTEGRATION_OSISO ?? '26.5';
const bundleId = process.env.IOS_HELPER_INTEGRATION_BUNDLE_ID;
const signal = () => new AbortController().signal;

/** Count the severities the raw log actually contains, case-insensitively. */
function rawSeverityCounts(log) {
  const counts = { error: 0, warning: 0, note: 0 };
  for (const line of log.split(/\r?\n/)) {
    const match = /^(?:.*?:\d+(?::\d+)?:\s*)?(?:-{2,}\s*)?(?:[^\s:][^:]*?:\s*)?(error|warning|note):\s+/i.exec(
      line,
    );
    if (match !== null) counts[match[1].toLowerCase()] += 1;
  }
  return counts;
}

test('a real build reports exactly the diagnostics its raw log contains', { skip }, async () => {
  const service = makeRealSubprocess();
  const { tool } = makeContext({
    spawn: service.spawn,
    config: { workspaceRoot: root, treatWarningsAsErrors: true },
  });

  const value = await tool('xcode_build').execute(
    { action: 'build', simulator, os, cwd: root },
    { signal: signal() },
  );

  assert.equal(
    value.ok,
    true,
    `the real build failed: ${String(value.summary)}\n${String(value.outputTail ?? '').slice(-2000)}`,
  );
  assert.match(String(value.summary), /succeeded/);

  const raw = rawSeverityCounts(service.log());
  assert.equal(
    value.errorCount,
    raw.error,
    `the plugin reported ${value.errorCount} error(s) but the raw log has ${raw.error}`,
  );
  assert.equal(
    value.warningCount,
    raw.warning,
    `the plugin reported ${value.warningCount} warning(s) but the raw log has ${raw.warning}` +
      `\nfirst raw warning: ${(service.log().split(/\r?\n/).find((l) => /warning:/i.test(l)) ?? '').trim()}`,
  );
});

test('a real clean reports the destination warning xcodebuild writes in upper case', { skip }, async () => {
  const service = makeRealSubprocess();
  const { tool } = makeContext({
    spawn: service.spawn,
    config: { workspaceRoot: root, treatWarningsAsErrors: true },
  });

  // No destination: xcodebuild resolves one itself and warns about the ambiguity.
  const value = await tool('xcode_build').execute({ action: 'clean', cwd: root }, { signal: signal() });

  // Guard against a vacuous pass: if nothing ran, both counts are 0 and the assertion
  // below would "succeed" while proving nothing.
  assert.ok(service.commands.length > 0, 'clean must actually have spawned xcodebuild');
  assert.match(String(value.summary), /clean (succeeded|failed)/i, 'the clean must have run');

  const raw = rawSeverityCounts(service.log());
  assert.equal(
    value.warningCount,
    raw.warning,
    `clean: the plugin reported ${value.warningCount} warning(s) but the raw log has ${raw.warning}`,
  );
  if (raw.warning > 0) {
    assert.match(
      String(value.diagnostics),
      /warning:/i,
      'a warned clean must not come back with an empty diagnostics list',
    );
  }
});

test('installs and launches the real build on a real simulator', { skip: skip || !bundleId }, async () => {
  const service = makeRealSubprocess();
  const { tool } = makeContext({
    spawn: service.spawn,
    config: { workspaceRoot: root, treatWarningsAsErrors: false },
  });

  const build = await tool('xcode_build').execute(
    { action: 'build', simulator, os, cwd: root },
    { signal: signal() },
  );
  const products = join(String(build.derivedDataPath), 'Build', 'Products', 'Debug-iphonesimulator');
  assert.ok(existsSync(products), `no products directory at ${products}`);
  const app = readdirSync(products).find((entry) => entry.endsWith('.app'));
  assert.ok(app !== undefined, `no .app in ${products}`);

  const value = await tool('simulator_install_launch').execute(
    { app_path: join(products, app), bundle_id: bundleId, device: simulator, terminate_existing: true, cwd: root },
    { signal: signal() },
  );
  assert.equal(value.ok, true, `install/launch failed: ${String(value.summary)}`);
  assert.match(String(value.summary), /installed .* in \d+\.\d+s/);
  assert.match(String(value.summary), /launched .* in \d+\.\d+s/);
});
