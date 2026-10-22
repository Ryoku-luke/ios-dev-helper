/**
 * Unit tests for `buildXcodeInvocation`.
 *
 * This is the payoff of extracting it: the exact command line a call will run — and
 * the notes explaining it — can be asserted directly, with no process and no stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildXcodeInvocation } from '../lib/index.js';

const CONFIG = {
  xcodebuildPath: 'xcodebuild',
  derivedDataPath: '.dsh/DerivedData',
  derivedDataPathConfigured: false,
};

function invoke(overrides = {}) {
  return buildXcodeInvocation({
    args: {},
    config: CONFIG,
    cwd: '/ws',
    action: 'build',
    target: 'X.xcodeproj',
    scheme: 'S',
    ...overrides,
  });
}

test('assembles the base command and applies the workspace DerivedData default', () => {
  const result = invoke();
  assert.ok(!('error' in result));
  assert.deepEqual(result.argv, [
    'xcodebuild',
    'build',
    '-project',
    'X.xcodeproj',
    '-scheme',
    'S',
    '-derivedDataPath',
    '/ws/.dsh/DerivedData',
  ]);
  assert.equal(result.derivedDataPath, '/ws/.dsh/DerivedData');
  assert.match(result.notes.join('\n'), /workspace DerivedData path \(default\)/);
  assert.equal(result.destination, undefined);
});

test('uses -workspace for a workspace target', () => {
  const result = invoke({ target: 'X.xcworkspace' });
  assert.ok(!('error' in result));
  assert.equal(result.argv[2], '-workspace');
});

test('forwards -configuration only when the caller asked for one', () => {
  const explicit = invoke({ args: { configuration: '  Release  ' } });
  assert.ok(!('error' in explicit));
  assert.ok(explicit.argv.join(' ').includes('-configuration Release'));

  const omitted = invoke();
  assert.ok(!('error' in omitted));
  assert.ok(!omitted.argv.includes('-configuration'));
});

test('composes a destination from simulator + os, and lets `destination` win', () => {
  const composed = invoke({ args: { simulator: 'iPhone 17 Pro', os: '26.5' } });
  assert.ok(!('error' in composed));
  assert.equal(composed.destination, 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5');

  const withoutOs = invoke({ args: { simulator: 'iPhone 17 Pro' } });
  assert.ok(!('error' in withoutOs));
  assert.equal(withoutOs.destination, 'platform=iOS Simulator,name=iPhone 17 Pro');

  const explicit = invoke({ args: { destination: 'generic/platform=iOS', simulator: 'iPhone 17 Pro' } });
  assert.ok(!('error' in explicit));
  assert.equal(explicit.destination, 'generic/platform=iOS');
});

test('does not invent a destination for actions that take none', () => {
  for (const action of ['clean', 'build-for-testing']) {
    const result = invoke({ action });
    assert.ok(!('error' in result));
    assert.equal(result.destination, undefined, action);
  }
});

test('honours an explicitly requested destination even for clean', () => {
  // Without a destination xcodebuild guesses and says so itself ("WARNING: Using the
  // first of multiple matching destinations"), and for `clean` a wrong guess can clean
  // another destination's products. A caller who named a simulator gets it honoured.
  const named = invoke({ action: 'clean', args: { simulator: 'iPhone 17 Pro', os: '26.5' } });
  assert.ok(!('error' in named));
  assert.equal(named.destination, 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5');
  assert.ok(named.argv.join(' ').includes('-destination'));

  const explicit = invoke({ action: 'clean', args: { destination: 'generic/platform=iOS' } });
  assert.ok(!('error' in explicit));
  assert.equal(explicit.destination, 'generic/platform=iOS');
});

test('appends -only-testing:<id> and trims/deduplicates the list', () => {
  const result = invoke({
    action: 'test',
    args: { onlyTesting: ['A/B', ' C ', 'A/B'] },
  });
  assert.ok(!('error' in result));
  const line = result.argv.join(' ');
  assert.ok(line.includes('-only-testing:A/B'));
  assert.ok(line.includes('-only-testing:C'));
  assert.equal((line.match(/-only-testing:/g) ?? []).length, 2);
});

test('accepts the legacy only_testing spelling', () => {
  const result = invoke({ action: 'test', args: { only_testing: ['Legacy/T'] } });
  assert.ok(!('error' in result));
  assert.ok(result.argv.join(' ').includes('-only-testing:Legacy/T'));
});

test('notes when onlyTesting is given for an action that ignores it', () => {
  const result = invoke({ action: 'build', args: { onlyTesting: ['A'] } });
  assert.ok(!('error' in result));
  assert.match(result.notes.join('\n'), /only constrains test actions/);
});

test('rejects malformed onlyTesting before anything can be spawned', () => {
  const cases = [
    ['not-an-array', 'must be an array'],
    [[], 'was empty'],
    [['A', ''], 'non-empty string'],
    [['A', 42], 'non-empty string'],
  ];
  for (const [value, expected] of cases) {
    const result = invoke({ action: 'test', args: { onlyTesting: value } });
    assert.ok('error' in result, String(value));
    assert.match(result.error, new RegExp(expected));
  }
});

test('resolves the DerivedData path by precedence: argument, config, default', () => {
  const byArgument = invoke({ args: { derived_data_path: '/custom/dd' } });
  assert.ok(!('error' in byArgument));
  assert.equal(byArgument.derivedDataPath, '/custom/dd');

  const byConfig = buildXcodeInvocation({
    args: {},
    config: { ...CONFIG, derivedDataPath: '.dsh/Configured', derivedDataPathConfigured: true },
    cwd: '/ws',
    action: 'build',
    target: 'X.xcodeproj',
    scheme: 'S',
  });
  assert.ok(!('error' in byConfig));
  assert.equal(byConfig.derivedDataPath, '/ws/.dsh/Configured');
  assert.match(byConfig.notes.join('\n'), /configured DerivedData path/);

  const relative = invoke({ args: { derived_data_path: 'rel/dd' } });
  assert.ok(!('error' in relative));
  assert.equal(relative.derivedDataPath, '/ws/rel/dd');
});

test('passes the DerivedData path as one argv element, never shell-quoted', () => {
  const result = invoke({ cwd: '/ws with spaces' });
  assert.ok(!('error' in result));
  const index = result.argv.indexOf('-derivedDataPath');
  assert.equal(result.argv[index + 1], '/ws with spaces/.dsh/DerivedData');
  assert.ok(!result.argv[index + 1].includes('"'));
});

test('appends extra_args verbatim and ignores blanks', () => {
  const result = invoke({ args: { extra_args: ['-quiet', '  ', '-jobs', '4'] } });
  assert.ok(!('error' in result));
  assert.deepEqual(result.argv.slice(-3), ['-quiet', '-jobs', '4']);
});

test('is deterministic: the same input yields the same command twice', () => {
  const first = invoke({ args: { simulator: 'iPhone 17 Pro', onlyTesting: ['A'] }, action: 'test' });
  const second = invoke({ args: { simulator: 'iPhone 17 Pro', onlyTesting: ['A'] }, action: 'test' });
  assert.deepEqual(first, second);
});

test('keeps a foldable name exactly as a name, and uses id= for a UDID', () => {
  const duo = invoke({ args: { simulator: 'iPhone Duo' } });
  assert.ok(!('error' in duo));
  assert.equal(duo.destination, 'platform=iOS Simulator,name=iPhone Duo');
  assert.ok(duo.argv.join(' ').includes('-destination platform=iOS Simulator,name=iPhone Duo'));

  const withOs = invoke({ args: { simulator: 'iPhone Duo', os: '27.1' } });
  assert.ok(!('error' in withOs));
  assert.equal(withOs.destination, 'platform=iOS Simulator,name=iPhone Duo,OS=27.1');

  const udid = 'E57CB0C4-444D-43C3-A4B0-66A092085EED';
  const byId = invoke({ args: { simulator: udid } });
  assert.ok(!('error' in byId));
  assert.equal(byId.destination, `platform=iOS Simulator,id=${udid}`);
});
