/**
 * Behaviour tests for the simulator tools: input validation, honest reporting, the
 * install retry policy, and host cancellation reaching the child process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_LIST, makeContext, makeWorkspace, render } from './support/harness.mjs';

const signal = () => new AbortController().signal;
const BOOTED = 'Unable to boot device in current state: Booted';
const SHUTDOWN = 'Unable to shutdown device in current state: Shutdown';

test('simulator_control rejects an unknown action without spawning anything', async () => {
  const { commands, tool } = makeContext();
  const value = await tool('simulator_control').execute({ action: 'shutown' }, { signal: signal() });
  assert.equal(value.ok, false);
  assert.match(String(value.summary), /unknown action "shutown"/);
  assert.match(String(value.summary), /valid actions are/);
  assert.deepEqual(commands, []);
});

test('simulator_control treats "already in the requested state" as success, only for that state', async () => {
  const cases = [
    ['shutdown', SHUTDOWN, true],
    ['boot', BOOTED, true],
    ['shutdown', 'Unable to shutdown device in current state: Booted', false],
    ['boot', 'Unable to boot device in current state: Shutdown', false],
  ];
  for (const [action, output, expected] of cases) {
    const { tool } = makeContext({
      outputs: [
        ['list devices', { text: DEVICE_LIST }],
        [`simctl ${action}`, { text: output, code: 149 }],
      ],
    });
    const value = await tool('simulator_control').execute(
      { action, device: 'iPhone 17 Pro' },
      { signal: signal() },
    );
    assert.equal(value.ok, expected, `${action}: ${output}`);
  }
});

test('simulator_control refuses a UDID that no simulator has', async () => {
  const { commands, tool } = makeContext({ outputs: [['list devices', { text: DEVICE_LIST }]] });
  const value = await tool('simulator_control').execute(
    { action: 'boot', device: '00000000-0000-0000-0000-000000000000' },
    { signal: signal() },
  );
  assert.equal(value.ok, false);
  assert.match(String(value.summary), /no simulator has the UDID/);
  assert.ok(!commands.some((line) => line.includes('simctl boot')), 'must not boot an unknown UDID');
});

test('simulator_control reports `open` honestly when the boot it needs fails', async () => {
  const { tool } = makeContext({
    outputs: [
      ['list devices', { text: DEVICE_LIST }],
      ['simctl boot', { text: 'Unable to boot device because it cannot be located on disk', code: 1 }],
    ],
  });
  const value = await tool('simulator_control').execute(
    { action: 'open', device: 'iPhone 17 Pro' },
    { signal: signal() },
  );
  assert.equal(value.ok, false);
  assert.match(render(tool('simulator_control'), value), /could not be booted/);
});

test('simulator_install_launch retries once on infrastructure flake, never on a real failure', async () => {
  const attempts = { flake: 0, real: 0 };
  const spawnWith = (mode) => (spec) => {
    const line = spec.argv.join(' ');
    let text = '';
    let code = 0;
    if (line.includes('list devices')) text = DEVICE_LIST;
    else if (line.includes('simctl install')) {
      if (mode === 'flake') {
        attempts.flake += 1;
        if (attempts.flake === 1) {
          text = 'Failed to install or launch the test runner (Busy)';
          code = 1;
        }
      } else {
        attempts.real += 1;
        text = 'Failed to write to device: no space left on device';
        code = 1;
      }
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
  };

  const flaky = makeContext({ spawn: spawnWith('flake') });
  const recovered = await flaky.tool('simulator_install_launch').execute(
    { app_path: '/tmp/X.app', device: 'iPhone 17 Pro', launch: false },
    { signal: signal() },
  );
  assert.equal(attempts.flake, 2, 'exactly one retry');
  assert.equal(recovered.ok, true);
  assert.ok((recovered.notes ?? []).some((note) => /retrying once/.test(note)));
  assert.match(String(recovered.summary), /in \d+\.\d+s/, 'the install duration is reported');

  const real = makeContext({ spawn: spawnWith('real') });
  const failed = await real.tool('simulator_install_launch').execute(
    { app_path: '/tmp/X.app', device: 'iPhone 17 Pro', launch: false },
    { signal: signal() },
  );
  assert.equal(attempts.real, 1, 'a real failure is never retried');
  assert.equal(failed.ok, false);
  assert.match(String(failed.summary), /no space left/);
});

test('simulator_install_launch names a timeout instead of reporting silence', async () => {
  const { tool } = makeContext({
    config: { simctlTimeoutMs: 1000 },
    spawn: (spec) => {
      const line = spec.argv.join(' ');
      const text = line.includes('list devices') ? DEVICE_LIST : '';
      const install = line.includes('simctl install');
      const done = new Promise((resolve) =>
        setTimeout(() => resolve(install ? { exitCode: null, signal: 'SIGTERM' } : { exitCode: 0, signal: null }), install ? 1200 : 0),
      );
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
  const value = await tool('simulator_install_launch').execute(
    { app_path: '/tmp/Big.app', device: 'iPhone 17 Pro', launch: false },
    { signal: signal() },
  );
  assert.equal(value.ok, false);
  assert.match(String(value.summary), /install timed out after 1000 ms/);
  assert.ok((value.notes ?? []).some((note) => /simctlTimeoutMs/.test(note)));
});

test('every simulator tool forwards the caller signal, and an abort reaches the provider', async () => {
  const cases = [
    ['xcode_info', { cwd: makeWorkspace() }],
    ['simulator_control', { action: 'list' }],
    ['simulator_install_launch', { app_path: '/tmp/X.app', device: 'iPhone 17 Pro' }],
    ['simulator_screenshot', { device: 'iPhone 17 Pro' }],
    ['simulator_logs', { seconds: 1 }],
  ];
  for (const [name, args] of cases) {
    let firstSpawn;
    const observed = [];
    const signals = [];
    const gate = new Promise((resolve) => {
      firstSpawn = resolve;
    });
    const { tool } = makeContext({
      config: { simctlTimeoutMs: 1000, buildTimeoutMs: 1000 },
      spawn: (spec) => {
        signals.push(spec.signal);
        const line = spec.argv.join(' ');
        let text = '';
        if (line.includes('ls -1d')) text = 'X.xcodeproj\n';
        else if (line.includes('-list')) text = JSON.stringify({ project: { schemes: ['S'] } });
        else if (line.includes('list devices')) text = DEVICE_LIST;
        else if (line.includes('runtimes')) text = JSON.stringify({ runtimes: [] });
        const done = new Promise((resolve) => {
          if (spec.signal === undefined) {
            resolve({ exitCode: 0, signal: null });
            return;
          }
          if (spec.signal.aborted) {
            observed.push(line);
            resolve({ exitCode: null, signal: 'SIGTERM' });
            return;
          }
          spec.signal.addEventListener(
            'abort',
            () => {
              observed.push(line);
              resolve({ exitCode: null, signal: 'SIGTERM' });
            },
            { once: true },
          );
        });
        firstSpawn();
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

    const controller = new AbortController();
    const pending = tool(name).execute(args, { signal: controller.signal });
    await gate;
    controller.abort();
    await pending;

    const withoutSignal = signals.filter((entry) => !(entry instanceof AbortSignal)).length;
    assert.equal(
      withoutSignal,
      0,
      `${name}: every spawn must receive a signal (${signals.length} spawns, ${withoutSignal} without)`,
    );
    assert.ok(observed.length > 0, `${name}: the provider must observe the abort`);
  }
});

test('a cancelled install is not retried', async () => {
  const installs = [];
  let firstSpawn;
  const gate = new Promise((resolve) => {
    firstSpawn = resolve;
  });
  const { tool } = makeContext({
    spawn: (spec) => {
      const line = spec.argv.join(' ');
      let text = '';
      if (line.includes('list devices')) text = DEVICE_LIST;
      if (line.includes('simctl install')) installs.push(line);
      const done = new Promise((resolve) => {
        if (spec.signal?.aborted) {
          resolve({ exitCode: null, signal: 'SIGTERM' });
          return;
        }
        spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true });
        // Resolve the flake only for a live (non-cancelled) install.
        if (line.includes('simctl install')) resolve({ exitCode: 1, signal: null });
      });
      firstSpawn();
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

  const controller = new AbortController();
  const pending = tool('simulator_install_launch').execute(
    { app_path: '/tmp/X.app', device: 'iPhone 17 Pro', launch: false },
    { signal: controller.signal },
  );
  await gate;
  controller.abort();
  await pending;
  assert.equal(installs.length, 1, 'the aborted install must not be retried');
});
