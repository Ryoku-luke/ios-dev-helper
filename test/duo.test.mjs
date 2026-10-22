/**
 * Foldable (`iPhone Duo`) support.
 *
 * The fixtures are copied from what Xcode 27.1 actually prints, because the point of
 * these tests is the real shape: `simctl list devices -j` carries `deviceTypeIdentifier`,
 * `simctl io <device> enumerate` groups screens into `Screen ID`/`Name`/`Device Name`/
 * `Screen Type` quads with `(1) LCD:` style headers between them, and a folded-away panel
 * captures as a near-empty PNG.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { makeContext, makeWorkspace, render } from './support/harness.mjs';

const DUO_UDID = 'E57CB0C4-444D-43C3-A4B0-66A092085EED';
const PHONE_UDID = 'D5969669-0A75-417B-87F8-5525A82A94A8';
const signal = () => new AbortController().signal;

/** Verbatim field names from `xcrun simctl list devices -j`. */
const DEVICES = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [
      {
        name: 'iPhone Duo',
        udid: DUO_UDID,
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo',
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      {
        name: 'iPhone 17 Pro',
        udid: PHONE_UDID,
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      },
    ],
  },
});

/** Copied from a real `simctl io <duo> enumerate`. */
const ENUMERATE = `
Port:
    UUID: A2148F74-9C47-40E7-B97D-0B4A8967D4E6
    Class: Display
    Power state: On
    Display class: 0
    Default width: 2007
    Default height: 2853

    Connected Screens:
        Screen ID: 2
        Name: TVOut
        Device Name: external-0
        Screen Type: TVOut
        Screen ID: 5
        Name: Resizable
        Device Name: resizable
        Screen Type: Scene
    (1) LCD:
        Screen ID: 1
        Name: LCD
        Device Name: primary
        Screen Type: Integrated
        Screen ID: 4
        Name: Wireless
        Device Name: wireless0
        Screen Type: CarPlay
    (3) LCD-1:
        Screen ID: 3
        Name: LCD-1
        Device Name: primary-1
        Screen Type: Integrated
`;


/**
 * A real PNG (8-bit RGB, filter 0 scanlines) whose pixels are all `rgb`.
 *
 * The tool measures pixels, so a synthetic `Buffer.alloc` would prove nothing — and a
 * black panel is exactly the case that a file-size heuristic got wrong in the real run.
 */
function makePng(width, height, rgb) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Spawn stub: answers enumerate, and writes a lit outer panel plus a black inner one. */
function duoSpawn({ panelBytes } = {}) {
  const calls = [];
  const pixels = panelBytes ?? { LCD: [255, 255, 255], 'LCD-1': [0, 0, 0] };
  return {
    calls,
    spawn(spec) {
      const line = spec.argv.join(' ');
      calls.push(line);
      let text = '';
      if (line.includes('list devices')) text = DEVICES;
      else if (line.includes('enumerate')) text = ENUMERATE;
      else if (line.includes('screenshot')) {
        const panel = line.includes('--display=LCD-1') ? 'LCD-1' : 'LCD';
        const target = spec.argv[spec.argv.length - 1];
        try {
          writeFileSync(target, makePng(24, 32, pixels[panel]));
        } catch {
          /* the tool reports the failure itself */
        }
      }
      const done = Promise.resolve({ exitCode: 0, signal: null });
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

test('the Duo is addressable by name, by UDID, and by device type', async () => {
  const cases = [
    ['name', 'iPhone Duo'],
    ['UDID', DUO_UDID],
    ['full device type', 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'],
    ['short device type', 'iPhone-Duo'],
  ];
  for (const [label, device] of cases) {
    const stub = duoSpawn();
    const { tool } = makeContext({ spawn: stub.spawn });
    const value = await tool('simulator_control').execute({ action: 'boot', device }, { signal: signal() });
    assert.equal(value.ok, true, `${label}: ${String(value.summary)}`);
    assert.ok(
      stub.calls.some((line) => line.includes('simctl boot') && line.includes(DUO_UDID)),
      `${label} must resolve to the Duo, got: ${stub.calls.join(' | ')}`,
    );
  }
});

test('duo_fold_state parses both panels and picks the one that is actually rendering', async () => {
  const cwd = makeWorkspace();
  const stub = duoSpawn();
  const { tool } = makeContext({ spawn: stub.spawn, config: { workspaceRoot: cwd } });
  const value = await tool('duo_fold_state').execute({ device: 'iPhone Duo', cwd }, { signal: signal() });

  assert.equal(value.ok, true);
  assert.equal(value.foldable, true, 'two integrated panels');
  assert.deepEqual(
    value.panels.map((panel) => panel.name),
    ['LCD', 'LCD-1'],
    'internal panels only: TVOut/Resizable/Wireless are not integrated',
  );
  assert.deepEqual(
    value.panels.map((panel) => panel.id),
    [1, 3],
    'screen IDs come from the enumeration',
  );
  assert.equal(value.activePanel, 'LCD', 'the panel with real content wins');
  assert.equal(value.panels[1].blank, true, 'the folded-away panel is flagged blank');
  assert.equal(value.panels[0].blank, false);
  assert.equal(value.panels[0].litRatio, 1, 'the outer panel is fully lit');
  assert.equal(value.panels[1].litRatio, 0, 'the inner panel is pure black, at whatever file size');
  assert.equal(value.panels[1].width, 24);
  assert.equal(value.panels[1].height, 32);
  assert.match(String(value.angleUnavailable), /CoreDeviceError 1001/);
  assert.match(String(value.angleUnavailable), /device motion/);
  assert.equal(value.foldAngle, undefined, 'the angle is never invented');
  assert.ok(
    stub.calls.some((line) => line.includes('screenshot') && line.includes('--display=LCD-1')),
    'the inner panel is captured by name',
  );
  assert.match(render(tool('duo_fold_state'), value), /active panel: LCD/);
});

test('duo_fold_state can report the enumeration alone', async () => {
  const cwd = makeWorkspace();
  const stub = duoSpawn();
  const { tool } = makeContext({ spawn: stub.spawn, config: { workspaceRoot: cwd } });
  const value = await tool('duo_fold_state').execute({ device: 'iPhone Duo', cwd, capture: false }, { signal: signal() });

  assert.equal(value.panels.length, 2);
  assert.equal(value.panels[0].bytes, undefined, 'nothing was captured');
  assert.equal(value.activePanel, undefined, 'without captures the active panel is unknown');
  assert.ok(!stub.calls.some((line) => line.includes('screenshot')));
});

test('a single-panel device is reported as not foldable', async () => {
  const cwd = makeWorkspace();
  const single = ENUMERATE.replace(/\(3\) LCD-1:[\s\S]*?Screen Type: Integrated/, '');
  const stub = duoSpawn();
  const spawn = (spec) => {
    if (spec.argv.join(' ').includes('enumerate')) {
      const done = Promise.resolve({ exitCode: 0, signal: null });
      return {
        collected: {
          stdout: { readFrom: () => ({ text: single, nextOffset: single.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done,
        terminate() {},
        waitForExit: () => done.then(() => true),
      };
    }
    return stub.spawn(spec);
  };
  const { tool } = makeContext({ spawn, config: { workspaceRoot: cwd } });
  const value = await tool('duo_fold_state').execute({ device: 'iPhone Duo', cwd }, { signal: signal() });
  assert.equal(value.foldable, false);
  assert.deepEqual(value.panels.map((panel) => panel.name), ['LCD']);
});

test('simulator_screenshot passes --display before the path, and omits it by default', async () => {
  const cwd = makeWorkspace();
  const panel = duoSpawn();
  const { tool } = makeContext({ spawn: panel.spawn, config: { workspaceRoot: cwd } });
  const withDisplay = await tool('simulator_screenshot').execute(
    { device: 'iPhone Duo', cwd, display: 'LCD-1', attach: false },
    { signal: signal() },
  );
  assert.equal(withDisplay.ok, true);
  const argv = panel.calls.find((line) => line.includes('screenshot'));
  assert.match(String(argv), /screenshot --display=LCD-1 \S+\.png$/, 'flag before the destination path');

  const plain = duoSpawn();
  const second = makeContext({ spawn: plain.spawn, config: { workspaceRoot: cwd } });
  await second.tool('simulator_screenshot').execute({ device: 'iPhone Duo', cwd, attach: false }, { signal: signal() });
  const plainArgv = plain.calls.find((line) => line.includes('screenshot'));
  assert.ok(!String(plainArgv).includes('--display'), 'no flag keeps the single-screen behaviour');
});
