/**
 * Behaviour tests for the `xcode_build` tool.
 *
 * These drive the tool through a stubbed subprocess service: what matters is the
 * command it asks for, what it reports back, and that it refuses bad input before
 * spawning anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext, makeWorkspace, render } from './support/harness.mjs';

const signal = () => new AbortController().signal;

test('an explicit target that does not exist fails before spawning xcodebuild', async () => {
  const cwd = makeWorkspace(['Real.xcodeproj']);
  const { commands, tool } = makeContext();
  const value = await tool('xcode_build').execute(
    { target: 'Nope.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );
  assert.equal(value.ok, false);
  assert.match(String(value.summary), /no `Nope\.xcodeproj` at/);
  assert.match(String(value.summary), /Found instead: Real\.xcodeproj/);
  assert.deepEqual(commands, [], 'nothing may be spawned for a missing target');
});

test('keeps error/warning bullets, drops notes, and counts honestly past the cap', async () => {
  const lines = [];
  for (let i = 0; i < 60; i += 1) lines.push(`/src/E${i}.swift:${i}:5: error: 错误 ${i}`);
  for (let i = 0; i < 50; i += 1) lines.push(`/src/W${i}.swift:${i}:5: warning: 警告 ${i}`);
  for (let i = 0; i < 80; i += 1) lines.push(`/src/N${i}.swift:${i}:5: note: 提示 ${i}`);
  const output = `${lines.join('\n')}\n** BUILD FAILED **\n`;

  const cwd = makeWorkspace();
  const { tool } = makeContext({
    outputs: [['xcodebuild', { text: output, code: 65 }]],
    config: { treatWarningsAsErrors: false },
  });
  const value = await tool('xcode_build').execute(
    { target: 'X.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );

  const bullets = String(value.diagnostics).split('\n').filter((line) => line.startsWith('- '));
  assert.equal(bullets.length, 40, 'bullets are capped at maxDiagnostics');
  assert.ok(!bullets.some((line) => line.includes(': note:')), 'notes are never surfaced');
  assert.match(String(value.summary), /60 error\(s\)/);
  assert.match(String(value.summary), /50 warning\(s\)/);
  assert.ok(
    (value.notes ?? []).some((note) => /omitted/.test(note)),
    'the omission must be reported',
  );
});

test('translates a write-permission failure into an actionable cause', async () => {
  const cwd = makeWorkspace();
  const { tool } = makeContext({
    outputs: [
      [
        'xcodebuild',
        {
          text: 'error: could not write to ~/Library/Developer/Xcode/DerivedData\nOperation not permitted\n',
          code: 65,
        },
      ],
    ],
  });
  const value = await tool('xcode_build').execute(
    { target: 'X.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );
  assert.equal(value.ok, false);
  assert.match(render(tool('xcode_build'), value), /write-permission failure/);
});

test('reports a build that crossed its budget yet finished on its own as a success', async () => {
  const cwd = makeWorkspace();
  const build = (outcome) =>
    makeContext({
      config: { buildTimeoutMs: 1000, graceMs: 1000, treatWarningsAsErrors: false },
      spawn: (spec) => {
        const text = spec.argv.join(' ').includes('xcodebuild') ? '** BUILD SUCCEEDED **\n' : '';
        const done = new Promise((resolve) => setTimeout(() => resolve(outcome), 1200));
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
    });

  const finished = build({ exitCode: 0, signal: null });
  const finishedValue = await finished.tool('xcode_build').execute(
    { target: 'X.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );
  assert.equal(finishedValue.ok, true);
  assert.ok((finishedValue.notes ?? []).some((note) => /finished on its own/.test(note)));

  const killed = build({ exitCode: null, signal: 'SIGTERM' });
  const killedValue = await killed.tool('xcode_build').execute(
    { target: 'X.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );
  assert.equal(killedValue.ok, false);
  assert.match(String(killedValue.summary), /was terminated after 1000 ms/);
});

test('shutdown_simulators runs `simctl shutdown all` before xcodebuild', async () => {
  const cwd = makeWorkspace();
  const { commands, tool } = makeContext({
    outputs: [['xcodebuild', { text: '** BUILD SUCCEEDED **\n' }]],
    config: { treatWarningsAsErrors: false },
  });
  await tool('xcode_build').execute(
    { action: 'test', target: 'X.xcodeproj', scheme: 'S', cwd, shutdown_simulators: true },
    { signal: signal() },
  );
  const shutdownAt = commands.findIndex((line) => line.includes('simctl shutdown all'));
  const buildAt = commands.findIndex((line) => line.includes('xcodebuild'));
  assert.ok(shutdownAt >= 0, 'shutdown all must run');
  assert.ok(shutdownAt < buildAt, 'shutdown must precede the build');
});

test('truncation of a long log never splits a surrogate pair', async () => {
  const cwd = makeWorkspace();
  // The kept tail starts exactly on the low surrogate of the emoji.
  const tailProbe = `${'x'.repeat(4000)}😀${'y'.repeat(5999)}`;
  const { tool } = makeContext({
    outputs: [['xcodebuild', { text: tailProbe }]],
    config: { treatWarningsAsErrors: false, maxOutputChars: 6000 },
  });
  const value = await tool('xcode_build').execute(
    { target: 'X.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );
  const text = String(value.outputTail);
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'lone high surrogate in the output tail');
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      const previous = text.charCodeAt(i - 1);
      assert.ok(previous >= 0xd800 && previous <= 0xdbff, 'lone low surrogate in the output tail');
    }
  }
});

test('surfaces an upper-case xcodebuild warning instead of reporting a clean run', async () => {
  // Verbatim from a real `xcodebuild clean` on this machine: xcodebuild writes its own
  // diagnostics in upper case, and the parser used to match lowercase only. The tool
  // therefore answered "0 warning(s)" for a run xcodebuild had warned about, and with
  // treatWarningsAsErrors it passed as clean.
  const cwd = makeWorkspace();
  const { tool } = makeContext({
    outputs: [
      [
        'xcodebuild',
        {
          text: '** CLEAN SUCCEEDED **\n',
          stderr:
            '--- xcodebuild: WARNING: Using the first of multiple matching destinations:\n' +
            '{ platform:iOS Simulator, name:iPhone 17 Pro }\n' +
            '{ platform:macOS, name:My Mac }\n',
          code: 0,
        },
      ],
    ],
    config: { treatWarningsAsErrors: true },
  });
  const value = await tool('xcode_build').execute(
    { action: 'clean', target: 'X.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );
  assert.equal(value.warningCount, 1, 'the upper-case warning must be counted');
  assert.equal(value.ok, false, 'treatWarningsAsErrors must fail a warned run');
  assert.match(String(value.diagnostics), /Using the first of multiple matching destinations/);
  assert.match(String(value.diagnostics), /^- xcodebuild: warning:/m, 'producer and severity are normalised');
});

test('still counts upper-case and lower-case severities the same way', async () => {
  const cwd = makeWorkspace();
  const { tool } = makeContext({
    outputs: [
      [
        'xcodebuild',
        {
          text: '/src/A.swift:1:2: ERROR: upper case error\n** BUILD FAILED **\n',
          code: 65,
        },
      ],
    ],
    config: { treatWarningsAsErrors: true },
  });
  const value = await tool('xcode_build').execute(
    { target: 'X.xcodeproj', scheme: 'S', cwd },
    { signal: signal() },
  );
  assert.equal(value.errorCount, 1);
  assert.equal(value.ok, false);
  assert.match(String(value.diagnostics), /^- \/src\/A\.swift:1:2: error: upper case error$/m);
});
