/**
 * Tests for `ios_verify_ui`.
 *
 * The tool has no eyes by design, so what is worth asserting is the protocol around
 * that fact: the criterion travels with every verdict, phase 1 really captures and
 * attaches (or says why it could not), and a negative verdict always comes back with
 * a reason and something the caller can act on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_LIST, makeContext, makeWorkspace, render } from './support/harness.mjs';

const signal = () => new AbortController().signal;
const CRITERIA = '屏幕上应该出现日历和日期选择器';
const screenshotOutputs = [
  ['list devices', { text: DEVICE_LIST }],
  ['simctl io', { text: '' }],
];

test('phase 1 captures, attaches and hands the criterion to the vision model', async () => {
  const cwd = makeWorkspace();
  const { commands, savedImages, tool } = makeContext({ outputs: screenshotOutputs, attachments: true });
  const value = await tool('ios_verify_ui').execute(
    { acceptance_criteria: `  ${CRITERIA}  `, cwd },
    { signal: signal() },
  );

  assert.equal(value.ok, true);
  assert.equal(value.status, 'awaiting_vision_judgement');
  assert.equal(value.acceptanceCriteria, CRITERIA, 'the criterion is trimmed and carried');
  assert.equal(value.passed, undefined, 'phase 1 must not invent a verdict');
  const captureName = String(value.screenshotPath).split('/').pop();
  assert.match(captureName, /^verify-.*\.png$/, 'verification captures are named distinctly');
  assert.ok(
    !captureName.startsWith('screenshot-'),
    'a verification capture must not be mistaken for a plain simulator_screenshot',
  );
  assert.equal(value.attached, true);
  assert.ok(value.image !== undefined, 'the capture must be attached for judging');
  assert.equal(savedImages.length, 1, 'exactly one image was attached');
  assert.ok(savedImages[0].bytes > 0, 'the attached image has content');
  assert.ok(commands.some((line) => line.includes('simctl io') && line.includes('screenshot')));

  const instructions = String(value.instructions);
  assert.match(instructions, /satisfies: "/, 'the instructions quote the criterion');
  assert.ok(instructions.includes(CRITERIA));
  assert.match(instructions, /passed: false/, 'the model is told how to report a failure');

  // The render must carry the ImageBlock, which is what the model actually sees.
  const blocks = tool('ios_verify_ui').output.render({}, value);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 1);
  assert.match(String(blocks[0].text), new RegExp(CRITERIA));
});

test('phase 1 says so when it cannot attach, and points at read_image', async () => {
  const cwd = makeWorkspace();
  const { tool } = makeContext({ outputs: screenshotOutputs });
  const value = await tool('ios_verify_ui').execute({ acceptance_criteria: CRITERIA, cwd }, { signal: signal() });

  assert.equal(value.status, 'awaiting_vision_judgement');
  assert.equal(value.attached, false);
  assert.equal(value.image, undefined);
  assert.match(render(tool('ios_verify_ui'), value), /read_image/);
});

test('phase 2 answers { passed: true } for a met criterion', async () => {
  const { tool } = makeContext();
  const value = await tool('ios_verify_ui').execute(
    { acceptance_criteria: CRITERIA, passed: true },
    { signal: signal() },
  );
  assert.equal(value.ok, true);
  assert.equal(value.passed, true);
  assert.equal(value.status, 'passed');
  assert.equal(value.acceptanceCriteria, CRITERIA);
});

test('phase 2 answers { passed: false, reason, nextSteps } and says what to do next', async () => {
  const { tool } = makeContext();
  const value = await tool('ios_verify_ui').execute(
    { acceptance_criteria: CRITERIA, passed: false, reason: '未发现日期选择器' },
    { signal: signal() },
  );
  assert.equal(value.ok, false, 'an unmet criterion is not a success');
  assert.equal(value.passed, false);
  assert.equal(value.status, 'failed');
  assert.equal(value.reason, '未发现日期选择器');
  assert.ok(Array.isArray(value.nextSteps) && value.nextSteps.length >= 3);
  const steps = value.nextSteps.join('\n');
  assert.match(steps, /simulator_elements/, 'the caller is told how to see what is actually on screen');
  assert.match(steps, /xcode_build/, 'the caller is told to rebuild after a fix');
  assert.match(steps, /simulator_install_launch/);
  assert.match(render(tool('ios_verify_ui'), value), /未发现日期选择器/);
});

test('a failure without a reason is refused, because it cannot be acted on', async () => {
  const { tool } = makeContext();
  const value = await tool('ios_verify_ui').execute(
    { acceptance_criteria: CRITERIA, passed: false },
    { signal: signal() },
  );
  assert.equal(value.status, 'invalid-arguments');
  assert.equal(value.passed, false);
  assert.match(String(value.summary), /must say what is wrong/);
});

test('the criterion is required in both phases', async () => {
  const { commands, tool } = makeContext({ outputs: screenshotOutputs });
  for (const args of [{}, { passed: true }, { acceptance_criteria: '   ', passed: false }]) {
    const value = await tool('ios_verify_ui').execute(args, { signal: signal() });
    assert.equal(value.status, 'invalid-arguments', JSON.stringify(args));
    assert.match(String(value.summary), /acceptance_criteria.*required/);
  }
  assert.deepEqual(commands, [], 'bad arguments must not touch the simulator');
});

test('reports a capture failure with the real command output', async () => {
  const cwd = makeWorkspace();
  const { tool } = makeContext({
    outputs: [
      ['list devices', { text: DEVICE_LIST }],
      ['simctl io', { text: 'No such device', code: 1 }],
    ],
  });
  const value = await tool('ios_verify_ui').execute({ acceptance_criteria: CRITERIA, cwd }, { signal: signal() });
  assert.equal(value.status, 'capture-failed');
  assert.equal(value.ok, false);
  assert.equal(value.exitCode, 1);
  assert.match(String(value.summary), /could not capture the screen/);
  // The failure must carry what simctl actually said, not just "it failed".
  assert.match(String(value.summary), /No such device/);
});

test('reports no booted simulator instead of a UI verdict', async () => {
  const cwd = makeWorkspace();
  const { tool } = makeContext({ outputs: [['list devices', { text: JSON.stringify({ devices: {} }) }]] });
  const value = await tool('ios_verify_ui').execute({ acceptance_criteria: CRITERIA, cwd }, { signal: signal() });
  assert.equal(value.status, 'no-device');
  assert.equal(value.ok, false);
  assert.equal(value.passed, undefined, 'an unrunnable check must not read as a failed criterion');
});
