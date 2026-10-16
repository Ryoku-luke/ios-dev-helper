/**
 * Tests for `cleanup_environment`.
 *
 * It kills processes and deletes build state, so the properties worth asserting are
 * the cautious ones: nothing happens without `confirm`, other people's `xcodebuild`
 * runs are left alone, a fresh build database survives by default, and a process that
 * ignores SIGTERM is escalated to SIGKILL rather than reported as cleaned.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_LIST, makeContext, makeWorkspace, render } from './support/harness.mjs';

const signal = () => new AbortController().signal;
const BOOTED = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17 Pro', udid: 'U-1', state: 'Booted' }] },
});

/** A git-less scratch DerivedData with one fresh and one backdated artifact. */
function makeDerivedData() {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-dd-'));
  const intermediates = join(root, 'Build', 'Intermediates.noindex', 'XCBuildData');
  mkdirSync(intermediates, { recursive: true });
  const freshDb = join(intermediates, 'build.db');
  writeFileSync(freshDb, 'fresh');
  const oldData = join(intermediates, 'deadbeef.xcbuilddata');
  writeFileSync(oldData, 'stale');
  const ancient = new Date(Date.now() - 5 * 60 * 60 * 1000);
  utimesSync(oldData, ancient, ancient);
  return { root, freshDb, oldData, intermediates };
}

/** Spawn stub whose pgrep answers differ between the list and the post-SIGTERM check. */
function cleanupSpawn({ pgrepLines, afterTermLines = [] }) {
  const calls = [];
  let pgrepCount = 0;
  return {
    calls,
    spawn(spec) {
      const line = spec.argv.join(' ');
      calls.push(line);
      let text = '';
      let code = 0;
      if (line.includes('pgrep')) {
        pgrepCount += 1;
        const lines = pgrepCount === 1 ? pgrepLines : afterTermLines;
        text = lines.length > 0 ? `${lines.join('\n')}\n` : '';
        code = lines.length > 0 ? 0 : 1; // pgrep exits 1 when nothing matches
      } else if (line.includes('list devices')) {
        text = BOOTED;
      }
      const done = Promise.resolve({ exitCode: code, signal: null });
      return {
        collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done,
        terminate() {},
        waitForExit: () => done.then(() => true),
      };
    },
  };
}

test('reports without confirm and changes nothing', async () => {
  const cwd = makeWorkspace();
  const dd = makeDerivedData();
  const stub = cleanupSpawn({
    pgrepLines: [`4242 /usr/bin/xcodebuild -project ${join(cwd, 'X.xcodeproj')} -scheme S`],
  });
  const { tool } = makeContext({
    spawn: stub.spawn,
    config: { workspaceRoot: cwd, derivedDataPath: dd.root, graceMs: 50 },
  });
  const value = await tool('cleanup_environment').execute({ cwd }, { signal: signal() });

  assert.equal(value.confirmed, false);
  assert.equal(value.processes.length, 1);
  assert.match(String(value.summary), /report only/);
  assert.equal(value.terminated, 0);
  assert.ok(!stub.calls.some((line) => line.includes('/bin/kill')), 'no signal may be sent without confirm');
  assert.ok(!stub.calls.some((line) => line.includes('shutdown all')), 'no simulator may be shut down');
  assert.equal(value.removedArtifacts.length, 0);
  assert.ok(value.artifacts.some((path) => path.endsWith('.xcbuilddata')), 'the stale artifact is listed');
  assert.equal(value.bootedSimulators.length, 1);
  assert.match(render(tool('cleanup_environment'), value), /Leftover processes/);
});

test('escalates a SIGTERM-ignoring process to SIGKILL', async () => {
  const cwd = makeWorkspace();
  const dd = makeDerivedData();
  const pgrepLine = `4242 /usr/bin/xcodebuild -project ${join(cwd, 'X.xcodeproj')}`;
  const stub = cleanupSpawn({ pgrepLines: [pgrepLine], afterTermLines: [pgrepLine] });
  const { tool } = makeContext({
    spawn: stub.spawn,
    config: { workspaceRoot: cwd, derivedDataPath: dd.root, graceMs: 50 },
  });
  const value = await tool('cleanup_environment').execute({ cwd, confirm: true }, { signal: signal() });

  const kills = stub.calls.filter((line) => line.includes('/bin/kill'));
  assert.equal(kills.length, 2, 'SIGTERM then SIGKILL');
  assert.match(kills[0], /-TERM 4242/);
  assert.match(kills[1], /-KILL 4242/);
  assert.equal(value.forceKilled, 1);
  assert.equal(value.terminated, 0);
  assert.equal(value.survived.length, 1, 'a process that survived must be reported, not hidden');
  assert.ok(stub.calls.some((line) => line.includes('shutdown all')), 'booted simulators are shut down');
});

test('never touches an xcodebuild that is not ours', async () => {
  const cwd = makeWorkspace();
  const dd = makeDerivedData();
  const mine = `11 /usr/bin/xcodebuild -project ${join(cwd, 'X.xcodeproj')}`;
  const theirs = '22 /usr/bin/xcodebuild -workspace /Users/someone/else/Other.xcworkspace';
  const stub = cleanupSpawn({ pgrepLines: [mine, theirs] });
  const { tool } = makeContext({
    spawn: stub.spawn,
    config: { workspaceRoot: cwd, derivedDataPath: dd.root, graceMs: 50 },
  });
  const value = await tool('cleanup_environment').execute({ cwd, confirm: true }, { signal: signal() });
  assert.equal(value.processes.length, 1);
  assert.match(String(value.processes[0]), /X\.xcodeproj/);
  assert.ok((value.notes ?? []).some((note) => /left alone/.test(note)));
  assert.match(stub.calls.filter((line) => line.includes('/bin/kill')).join('\n'), /-TERM 11(?!\d)/);
});

test('removes only stale artifacts unless asked for the build database', async () => {
  const cwd = makeWorkspace();
  const dd = makeDerivedData();
  const stub = cleanupSpawn({ pgrepLines: [] });
  const { existsSync } = await import('node:fs');
  const base = {
    spawn: stub.spawn,
    config: { workspaceRoot: cwd, derivedDataPath: dd.root, graceMs: 50 },
  };

  const cautious = makeContext(base);
  const first = await cautious.tool('cleanup_environment').execute({ cwd, confirm: true }, { signal: signal() });
  assert.equal(first.artifacts.length, 1, 'only the stale artifact is eligible');
  assert.equal(existsSync(dd.oldData), false, 'the stale artifact is gone');
  assert.equal(existsSync(dd.freshDb), true, 'a fresh build database survives by default');

  const forced = makeContext(base);
  const second = await forced.tool('cleanup_environment').execute(
    { cwd, confirm: true, remove_build_database: true },
    { signal: signal() },
  );
  assert.ok(second.artifacts.some((path) => path.endsWith('build.db')));
  assert.equal(existsSync(dd.freshDb), false, 'remove_build_database takes it anyway');
});

test('the whole cleanup can be cancelled', async () => {
  const cwd = makeWorkspace();
  const controller = new AbortController();
  let spawned = 0;
  const { tool } = makeContext({
    config: { workspaceRoot: cwd, graceMs: 50 },
    spawn: (spec) => {
      spawned += 1;
      const done = new Promise((resolve) => {
        if (spec.signal?.aborted) {
          resolve({ exitCode: null, signal: 'SIGTERM' });
          return;
        }
        spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true });
      });
      return {
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done,
        terminate() {},
        waitForExit: () => done.then(() => true),
      };
    },
  });
  const pending = tool('cleanup_environment').execute({ cwd, confirm: true }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await pending;
  assert.ok(spawned > 0, 'the cleanup must have started');
});
