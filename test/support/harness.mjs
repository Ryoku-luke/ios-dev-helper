/**
 * Shared support for the ios-dev-helper test suite.
 *
 * The plugin reaches the outside world only through the `subprocess` service, so
 * every test drives it with a stubbed context: `makeContext()` records the exact
 * commands it was asked to run and answers each one from a canned list.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plugin = await import(new URL('../../lib/index.js', import.meta.url));

/**
 * Create a scratch workspace. The `target` preflight requires the project to exist,
 * so tests that pass an explicit target need one of these.
 *
 * @param entries Directory entries to create, e.g. `['X.xcodeproj']`.
 * @returns Absolute path of the scratch directory.
 */
export function makeWorkspace(entries = ['X.xcodeproj']) {
  const dir = mkdtempSync(join(tmpdir(), 'ios-dev-helper-'));
  for (const entry of entries) mkdirSync(join(dir, entry), { recursive: true });
  return dir;
}

/** A subprocess handle shaped like the service contract, for one canned command. */
function handleFor(spec, output) {
  const text = output?.text ?? '';
  const done = Promise.resolve({ exitCode: output?.code ?? 0, signal: output?.signal ?? null });
  return {
    collected: {
      stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: output?.stderr ?? '', nextOffset: 0, lossy: false }) },
    },
    done,
    terminate() {},
    waitForExit: () => done.then(() => true),
  };
}

/**
 * Load the plugin against a stubbed context.
 *
 * @param options.outputs `[needle, { text, stderr, code, signal }]` pairs; the first whose
 *   needle appears in the command line answers it. Order matters.
 * @param options.config Plugin config overrides.
 * @param options.spawn Custom spawn implementation (used by cancellation tests).
 * @returns The tool registry, the recorded command lines, the spawned signals and the
 *   registered system-prompt section (see `sectionOf`).
 */
export function makeContext({ outputs = [], config = {}, spawn } = {}) {
  const commands = [];
  const spawnedSignals = [];
  const registry = new Map();
  let section;

  const defaultSpawn = (spec) => {
    const line = spec.argv.join(' ');
    commands.push(line);
    spawnedSignals.push(spec.signal);
    const match = outputs.find(([needle]) => line.includes(needle));
    return handleFor(spec, match === undefined ? {} : match[1]);
  };

  const subprocess = { spawn: spawn ?? defaultSpawn };
  const ctx = {
    tools: {
      register: (definition) => {
        registry.set(definition.name, definition);
        return () => {};
      },
      get: (name) => registry.get(name),
    },
    subprocess,
    systemPrompt: {
      section: (value) => {
        section = value;
        return () => {};
      },
      getSectionOrder: () => 0,
    },
    get: (name) => (name === 'subprocess' ? subprocess : undefined),
  };
  plugin.apply(ctx, config);
  return { registry, commands, spawnedSignals, section, tool: (name) => registry.get(name) };
}

/** The heading of the guidance section the plugin registered. */
export function sectionHeading(section) {
  return String(section?.text({ scope: undefined }) ?? '').split('\n')[0];
}

/** Render a tool result the way the model would receive it. */
export function render(tool, value) {
  return tool.output.render({}, value).map((block) => block.text ?? '').join('\n');
}

/** The project/device listing every device-aware tool needs. */
export const DEVICE_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { name: 'iPhone 17 Pro', udid: 'UITEST-UDID', state: 'Booted', isAvailable: true },
    ],
  },
});
