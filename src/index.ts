/**
 * ios-dev-helper — an iOS development companion plugin for DeepSeek Harness.
 *
 * It contributes three capabilities to whatever Agent scope loads it:
 *
 * 1. Xcode build (`xcode_build`, `xcode_info`, `ios_dependencies`) — wraps
 *    `xcodebuild`, discovers the workspace/project and scheme from the Agent's
 *    working directory, and parses compiler diagnostics out of the build output
 *    into model-friendly bullets. `ios_dependencies` resolves dependencies before
 *    a first build by detecting a `Podfile` (`pod install`) or a `Package.swift`
 *    (`swift package resolve`) in the working directory.
 * 2. Simulator control (`simulator_control`, `simulator_install_launch`,
 *    `simulator_screenshot`, `simulator_logs`, `simulator_tap`,
 *    `simulator_elements`) — wraps `xcrun simctl` to boot/shutdown/list
 *    simulators, install + launch a built `.app` bundle, capture the booted
 *    screen to a PNG whose absolute path is returned for visual inspection, and
 *    listen to the unified log for its error/fault lines. Touch injection and
 *    accessibility queries go through `idb` instead, because `simctl` has no tap
 *    command at all.
 * 3. SwiftUI guidance — a system-prompt section asking the Agent to prefer SwiftUI
 *    and to follow Apple's current Human Interface Guidelines.
 *
 * Every external process goes through the `subprocess` Service (`ctx.subprocess`),
 * so spawned children inherit the harness's own authority and are tracked for
 * teardown by the composition. No `node:child_process` import is used.
 *
 * @module ios-dev-helper
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Services this plugin needs. The plugin stays inactive without them. */
export const inject = ['tools', 'subprocess', 'systemPrompt'];

/** Resolved plugin configuration. */
interface HelperConfig {
  /** Default working directory for builds when a tool call does not pass one. */
  workspaceRoot: string;
  /** Absolute path to `xcodebuild`, or a bare PATH name. */
  xcodebuildPath: string;
  /** Absolute path to `xcrun`, or a bare PATH name. */
  xcrunPath: string;
  /**
   * Where `xcodebuild` keeps its intermediate products. Pointing every build at
   * one stable path is what makes repeat builds incremental instead of cold.
   * A relative value resolves against the build's working directory; the default
   * is `.dsh/DerivedData` inside that workspace.
   */
  derivedDataPath: string;
  /**
   * True when `derivedDataPath` came from the plugin configuration rather than
   * from the built-in default. Derived from the raw config, never set by users.
   * An explicitly configured path is honoured even before it exists; the default
   * is only used once the directory is actually there.
   */
  derivedDataPathConfigured: boolean;
  /**
   * Directory that `simulator_screenshot` writes into when no explicit `path` is
   * given. A relative value resolves against the build's working directory, so
   * the default `.dsh/screenshots` lands inside the workspace.
   */
  screenshotDir: string;
  /**
   * Path to the `idb` CLI (the fb-idb client) used by `simulator_tap` and
   * `simulator_elements`. A leading `~` expands to the home directory. `idb` is
   * the only supported way to inject touches into a simulator: `simctl` has no
   * tap command of its own.
   */
  idbPath: string;
  /**
   * Wall-clock budget for one `idb` invocation. Generous by default because the
   * first call in a session starts the `idb_companion` daemon.
   */
  idbTimeoutMs: number;
  /**
   * Path to the CocoaPods CLI used by `ios_dependencies`. A leading `~` expands
   * to the home directory.
   */
  podPath: string;
  /** Path to the SwiftPM CLI used by `ios_dependencies`. */
  swiftPath: string;
  /**
   * Budget for one dependency command (`pod install` / `swift package resolve`).
   * A cold `pod install` downloads pods, so minutes are normal.
   */
  dependenciesTimeoutMs: number;
  /** Wall-clock budget for one `xcodebuild` invocation, in milliseconds. */
  buildTimeoutMs: number;
  /** Wall-clock budget for one `simctl` invocation, in milliseconds. */
  simctlTimeoutMs: number;
  /** Per-stream byte budget kept in memory before a collector spills to disk. */
  maxOutputBytes: number;
  /** Maximum diagnostic bullets surfaced to the model. */
  maxDiagnostics: number;
  /** Maximum characters of raw build output surfaced to the model. */
  maxOutputChars: number;
  /** Grace period between SIGTERM and SIGKILL for a managed child. */
  graceMs: number;
  /** Whether to register the SwiftUI system-prompt section. */
  injectSwiftUIGuidance: boolean;
  /** Treat compiler warnings as a failed build, matching this project's CI rule. */
  treatWarningsAsErrors: boolean;
}

/** A compiler diagnostic recovered from build output. */
interface Diagnostic {
  file: string;
  line?: number;
  column?: number;
  severity: string;
  message: string;
}

/** The normalized outcome of one managed child process. */
interface CommandResult {
  /** Combined stdout/stderr, already bounded. */
  output: string;
  /** Process exit code, or null when the child died from a signal. */
  exitCode: number | null;
  /** Terminating signal name, or null on a normal exit. */
  signal: string | null;
  /** True when the collector dropped bytes because a stream overflowed. */
  lossy: boolean;
  /** True when the harness killed the child for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** True when no `subprocess` Service was available in this scope. */
  unavailable: boolean;
}

/** Minimal structural view of the Cordis context this plugin relies on. */
interface Ctx {
  tools: {
    register(definition: unknown): () => void;
    get(name: string, scope?: object): unknown;
  };
  subprocess?: {
    spawn(spec: {
      argv: readonly string[];
      cwd: string;
      stdio: {
        stdin: 'ignore' | 'pipe' | { data: string };
        stdout: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } };
        stderr: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } };
        control?: 'pipe';
      };
      graceMs: number;
      signal?: AbortSignal;
      env?: Record<string, string | undefined>;
    }): {
      collected: {
        stdout?: { readFrom(fromByte: number): OutputRead };
        stderr?: { readFrom(fromByte: number): OutputRead };
      };
      done: Promise<{ exitCode: number | null; signal: string | null }>;
      terminate(): void;
      waitForExit(signal?: AbortSignal): Promise<boolean>;
    };
  };
  systemPrompt: {
    section(section: {
      name: string;
      order: number;
      text: string | ((context: { scope?: object }) => string);
      interpolate?: boolean;
      complete?: boolean;
    }): () => void;
    getSectionOrder(name: string): number;
  };
  effect(callback: () => (() => void) | void): () => void;
  get(name: string): unknown;
}

/** One non-consuming read from a collected output stream. */
interface OutputRead {
  text: string;
  nextOffset: number;
  lossy: boolean;
  spillPath?: string;
}

const DEFAULT_CONFIG: HelperConfig = {
  workspaceRoot: '',
  xcodebuildPath: 'xcodebuild',
  xcrunPath: 'xcrun',
  derivedDataPath: '.dsh/DerivedData',
  derivedDataPathConfigured: false,
  screenshotDir: '.dsh/screenshots',
  idbPath: 'idb',
  idbTimeoutMs: 120000,
  podPath: 'pod',
  swiftPath: 'swift',
  dependenciesTimeoutMs: 5 * 60 * 1000,
  buildTimeoutMs: 15 * 60 * 1000,
  simctlTimeoutMs: 2 * 60 * 1000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxDiagnostics: 40,
  maxOutputChars: 6000,
  graceMs: 3000,
  injectSwiftUIGuidance: true,
  treatWarningsAsErrors: true,
};

/** Payload of the SwiftUI/HIG system-prompt section owned by this plugin. */
const SWIFTUI_GUIDANCE = `## iOS development conventions (ios-dev-helper)

When you write or modify UI code for an Apple platform in this session:

- **Prefer SwiftUI.** Reach for a UIKit/AppKit view only when the requested control or
  behavior has no SwiftUI equivalent, and say why in one line when you do.
- **Follow Apple's current Human Interface Guidelines**: use the platform's standard
  controls and navigation patterns (NavigationStack, TabView, sheets, menus) instead of
  hand-rolled substitutes; support Dynamic Type with semantic fonts
  (\`.font(.headline)\`, never a hard-coded point size for body text); respect safe areas,
  layout margins, and the user's light/dark appearance and accent color.
- **Accessibility is part of "done".** Give every meaningful control a label, keep
  hit targets at least 44x44 pt, and provide text alternatives for icon-only affordances.
- **State belongs in observable models.** Use \`@Observable\` (or \`ObservableObject\` on
  older deployment targets), \`@State\`, and \`@Bindable\` per their intended ownership
  rules; keep views declarative and free of side effects in \`body\`.
- **Prefer modern async APIs** (\`Task\`, \`.task {}\`, \`async/await\`) over completion
  handlers and manual dispatch queues.
- Locate UI strings in the project's existing localization mechanism instead of
  inlining new literals when the project already localizes.

After changing Swift sources, build with the \`xcode_build\` tool rather than guessing,
and report the compiler diagnostics it returns.`;

/** Clamp a number into an inclusive range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Read a positive finite number from raw config, else the fallback. */
function positiveNumber(raw: unknown, fallback: number, low: number, high: number): number {
  const value = typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(value) && value > 0 ? clamp(value, low, high) : fallback;
}

/** Resolve raw plugin config (from `cordis.patch.yml`) into a complete config. */
function resolveConfig(raw: unknown): HelperConfig {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (key: keyof HelperConfig, fallback: string): string => {
    const value = source[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  };
  const flag = (key: keyof HelperConfig, fallback: boolean): boolean => {
    const value = source[key];
    return typeof value === 'boolean' ? value : fallback;
  };
  const rawDerivedData = source.derivedDataPath;
  const derivedDataConfigured = typeof rawDerivedData === 'string' && rawDerivedData.trim().length > 0;
  return {
    workspaceRoot: text('workspaceRoot', DEFAULT_CONFIG.workspaceRoot),
    xcodebuildPath: text('xcodebuildPath', DEFAULT_CONFIG.xcodebuildPath),
    xcrunPath: text('xcrunPath', DEFAULT_CONFIG.xcrunPath),
    derivedDataPath: derivedDataConfigured ? (rawDerivedData as string).trim() : DEFAULT_CONFIG.derivedDataPath,
    derivedDataPathConfigured: derivedDataConfigured,
    screenshotDir: text('screenshotDir', DEFAULT_CONFIG.screenshotDir),
    idbPath: text('idbPath', DEFAULT_CONFIG.idbPath),
    idbTimeoutMs: positiveNumber(source.idbTimeoutMs, DEFAULT_CONFIG.idbTimeoutMs, 1000, 30 * 60 * 1000),
    podPath: text('podPath', DEFAULT_CONFIG.podPath),
    swiftPath: text('swiftPath', DEFAULT_CONFIG.swiftPath),
    dependenciesTimeoutMs: positiveNumber(
      source.dependenciesTimeoutMs,
      DEFAULT_CONFIG.dependenciesTimeoutMs,
      1000,
      60 * 60 * 1000,
    ),
    buildTimeoutMs: positiveNumber(source.buildTimeoutMs, DEFAULT_CONFIG.buildTimeoutMs, 1000, 6 * 60 * 60 * 1000),
    simctlTimeoutMs: positiveNumber(source.simctlTimeoutMs, DEFAULT_CONFIG.simctlTimeoutMs, 1000, 60 * 60 * 1000),
    maxOutputBytes: positiveNumber(source.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes, 64 * 1024, 128 * 1024 * 1024),
    maxDiagnostics: positiveNumber(source.maxDiagnostics, DEFAULT_CONFIG.maxDiagnostics, 1, 500),
    maxOutputChars: positiveNumber(source.maxOutputChars, DEFAULT_CONFIG.maxOutputChars, 500, 200000),
    graceMs: positiveNumber(source.graceMs, DEFAULT_CONFIG.graceMs, 100, 30000),
    injectSwiftUIGuidance: flag('injectSwiftUIGuidance', DEFAULT_CONFIG.injectSwiftUIGuidance),
    treatWarningsAsErrors: flag('treatWarningsAsErrors', DEFAULT_CONFIG.treatWarningsAsErrors),
  };
}

/** True when `value` is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Trim trailing whitespace and cap a string at `max` characters, keeping the head. */
function bounded(text: string, max: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  return trimmed.length <= max
    ? { text: trimmed, truncated: false }
    : { text: `${trimmed.slice(0, max)}\n… (${trimmed.length - max} more characters truncated)`, truncated: true };
}

/**
 * Keep the *end* of a string, capped at `max` characters.
 *
 * Build logs put their verdict last (`** BUILD SUCCEEDED **`, the error count,
 * the failing target), so the tail is the useful half of a long log.
 */
function boundedTail(text: string, max: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  return trimmed.length <= max
    ? { text: trimmed, truncated: false }
    : { text: `… (${trimmed.length - max} earlier characters truncated)\n${trimmed.slice(trimmed.length - max)}`, truncated: true };
}

/**
 * Run one managed child process to completion and collect its bounded output.
 * A nonzero exit code is a normal result; only infrastructure failures throw.
 */
async function runCommand(
  ctx: Ctx,
  config: HelperConfig,
  options: { argv: readonly string[]; cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CommandResult> {
  const subprocess = ctx.subprocess ?? (ctx.get('subprocess') as Ctx['subprocess'] | undefined);
  if (subprocess === undefined) {
    return {
      output: 'the `subprocess` service is not available in this scope, so no command was executed',
      exitCode: null,
      signal: null,
      lossy: false,
      timedOut: false,
      unavailable: true,
    };
  }

  // A child that outlives its budget is signalled, then killed after `graceMs`.
  const controller = new AbortController();
  const caller = options.signal;
  const onCallerAbort = (): void => controller.abort();
  if (caller !== undefined) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }

  let timedOut = false;
  const collect = { maxBytes: config.maxOutputBytes };
  let clearTimer: (() => void) | undefined;

  try {
    // Spawn inside the guard: a provider may reject an executable synchronously
    // (a missing `pod`, a bad path), which is the same "cannot run this" outcome
    // as a later failure and must not escape as an uncaught exception.
    const handle = subprocess.spawn({
      argv: options.argv,
      cwd: options.cwd,
      stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
      graceMs: config.graceMs,
      signal: controller.signal,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    clearTimer = () => clearTimeout(timer);

    const outcome = await handle.done;
    if (timedOut && outcome.exitCode === null) handle.terminate();
    const stdout = handle.collected.stdout?.readFrom(0);
    const stderr = handle.collected.stderr?.readFrom(0);
    const pieces: string[] = [];
    if (stdout !== undefined && stdout.text.length > 0) pieces.push(stdout.text);
    if (stderr !== undefined && stderr.text.length > 0) {
      pieces.push(pieces.length > 0 && !stdout!.text.endsWith('\n') ? `\n[stderr]\n${stderr.text}` : `[stderr]\n${stderr.text}`);
    }
    return {
      output: pieces.join(''),
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      lossy: stdout?.lossy === true || stderr?.lossy === true,
      timedOut,
      unavailable: false,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      output: `failed to run \`${options.argv.join(' ')}\`: ${detail}`,
      exitCode: null,
      signal: null,
      lossy: false,
      timedOut: false,
      unavailable: true,
    };
  } finally {
    clearTimer?.();
    caller?.removeEventListener('abort', onCallerAbort);
  }
}

// Xcode diagnostics look like:
//   /abs/path/File.swift:12:5: error: cannot find 'foo' in scope
//   /abs/path/File.swift:12: error: ...
//   <unknown>:0: error: ...            (no usable path)
const DIAGNOSTIC_PATTERN = /^(.*?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.*)$/;
// `xcodebuild` also reports failures that carry no file/line at all, and those
// are exactly the ones a caller most needs (a missing scheme, an unmatched
// destination). Without these fallbacks a failed build reported "0 errors".
//   xcodebuild: error: The project named "X" does not contain a scheme named "Y"
//   error: something went wrong
const TOOL_DIAGNOSTIC_PATTERN = /^([^\s:][^:]*?):\s*(error|warning):\s*(.*)$/;
const BARE_DIAGNOSTIC_PATTERN = /^(error|warning):\s*(.*)$/;
const TARGET_HEADER_PATTERN = /^===\s*(.+?)\s*===$/;

/**
 * Parse compiler diagnostics from `xcodebuild` output.
 *
 * Only `error` and `warning` become bullets: `note` lines are informational
 * (input encodings, dependency-order chatter) and on a clean build they used to
 * bury the verdict under a dozen irrelevant lines.
 */
function parseDiagnostics(output: string, limit: number): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (TARGET_HEADER_PATTERN.test(line)) continue;
    let file = '';
    let lineNumber: number | undefined;
    let column: number | undefined;
    let severity = '';
    let message = '';

    const located = DIAGNOSTIC_PATTERN.exec(line);
    if (located !== null) {
      const [, locatedFile, locatedLine, locatedColumn, locatedSeverity, locatedMessage] = located;
      file = locatedFile.trim();
      lineNumber = Number(locatedLine);
      column = locatedColumn !== undefined ? Number(locatedColumn) : undefined;
      severity = locatedSeverity;
      message = locatedMessage;
    } else {
      const bare = BARE_DIAGNOSTIC_PATTERN.exec(line);
      const tool = bare === null ? TOOL_DIAGNOSTIC_PATTERN.exec(line) : null;
      const match = bare ?? tool;
      if (match === null) continue;
      // For `xcodebuild: error: ...` the leading token names the producer.
      file = bare !== null ? 'xcodebuild' : (match[1] ?? 'xcodebuild').trim();
      severity = match[bare !== null ? 1 : 2] ?? '';
      message = match[bare !== null ? 2 : 3] ?? '';
    }

    if (severity === 'note') continue;
    // Skip the SwiftPM/sandbox cache noise this project deliberately whitelists.
    if (/swiftpm|not writable|readonly database/i.test(message)) continue;
    found.push({
      file: file.length === 0 ? 'xcodebuild' : file,
      ...(lineNumber !== undefined ? { line: lineNumber } : {}),
      ...(column !== undefined ? { column } : {}),
      severity,
      message: message.trim(),
    });
    if (found.length >= limit) break;
  }
  return found;
}

/** Render diagnostics as compact single lines, deduplicated in order. */
function formatDiagnostics(diagnostics: Diagnostic[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of diagnostics) {
    // A tool-level diagnostic has no position; print just the producer name
    // rather than a misleading `:0`.
    const where =
      item.line !== undefined
        ? `${item.file}:${item.line}${item.column !== undefined ? `:${item.column}` : ''}`
        : item.file;
    const line = `- ${where}: ${item.severity}: ${item.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join('\n');
}

/** Discover the workspace/project, schemes, and default scheme in one directory. */
async function discoverProject(
  ctx: Ctx,
  config: HelperConfig,
  cwd: string,
): Promise<{
  target?: string;
  schemes: string[];
  diagnostics: string;
  detectionLog: string;
}> {
  const ls = await runCommand(ctx, config, {
    argv: [config.xcrunPath, 'simctl', 'list', 'devices', 'available'],
    cwd,
    timeoutMs: config.simctlTimeoutMs,
  });
  if (ls.unavailable) return { schemes: [], diagnostics: '', detectionLog: ls.output };

  const probe = await runCommand(ctx, config, {
    argv: ['/bin/sh', '-c', 'ls -1d *.xcworkspace *.xcodeproj 2>/dev/null'],
    cwd,
    timeoutMs: 15000,
  });
  if (probe.unavailable) return { schemes: [], diagnostics: '', detectionLog: probe.output };

  const candidates = probe.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.xcworkspace') || line.endsWith('.xcodeproj'));
  if (candidates.length === 0) {
    return { schemes: [], diagnostics: '', detectionLog: `no .xcworkspace or .xcodeproj found in ${cwd}` };
  }

  // A workspace hides the project inside it, so prefer it when both exist.
  const target = candidates.find((name) => name.endsWith('.xcworkspace')) ?? candidates[0];
  const flag = target.endsWith('.xcworkspace') ? '-workspace' : '-project';
  const listed = await runCommand(ctx, config, {
    argv: [config.xcodebuildPath, '-list', flag, target, '-json'],
    cwd,
    timeoutMs: 120000,
  });

  let schemes: string[] = [];
  let diagnostics = '';
  const record = parseJsonObject(listed.output);
  if (record !== undefined) {
    const fromJson = record.schemes;
    if (Array.isArray(fromJson)) schemes = fromJson.filter(isNonEmptyString);
    const project = record.project as Record<string, unknown> | undefined;
    if (schemes.length === 0 && project !== undefined && Array.isArray(project.schemes)) {
      schemes = project.schemes.filter(isNonEmptyString);
    }
    diagnostics = isNonEmptyString(record.error) ? record.error : '';
  }
  if (schemes.length === 0) {
    // `-json` is unavailable on old toolchains, and a project can legitimately
    // report no schemes: fall back to the human-readable list output.
    schemes = schemesFromText(listed.output);
    if (schemes.length === 0 && listed.exitCode !== 0) diagnostics = listed.output;
  }

  return { target, schemes, diagnostics, detectionLog: '' };
}

/**
 * Pull the first top-level JSON object out of mixed tool output.
 *
 * `xcodebuild -list -json` prints its own invocation first, which contains a
 * literal `{` inside the `-destination` value, so a naive `indexOf('{')` finds
 * that brace instead of the document. A real JSON object opens with `"` (a
 * quoted key) or `}` (empty), so each `{` is checked against that before
 * scanning its balanced extent.
 */
function extractJsonObject(output: string): string | undefined {
  for (let start = output.indexOf('{'); start >= 0; start = output.indexOf('{', start + 1)) {
    let lookahead = start + 1;
    while (lookahead < output.length && /\s/.test(output[lookahead])) lookahead += 1;
    const next = output[lookahead];
    if (next !== '"' && next !== '}') continue;
    const candidate = scanBalancedObject(output, start);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/** Scan a balanced brace region starting at `start`, honouring string literals. */
function scanBalancedObject(output: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return output.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * Parse a JSON document out of tool output, tolerating extractor or toolchain
 * surprises. A malformed document yields `undefined` so the caller can fall
 * back to a text form instead of failing the whole tool call.
 */
function parseJsonObject(output: string): Record<string, any> | undefined {
  const candidate = extractJsonObject(output);
  if (candidate === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the scheme list from the human-readable `xcodebuild -list` output. */
function schemesFromText(output: string): string[] {
  const match = /Schemes:\s*\n([\s\S]*?)(?:\n\s*\n|$)/.exec(output);
  if (match === null) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(':'));
}

/**
 * Choose the scheme that belongs to the inspected target.
 *
 * Xcode's own convention is that an app target carries a scheme named after the
 * project (or workspace), so an exact name match is the safest automatic choice.
 * A scheme merely *starting* with that name (e.g. `App` vs `AppWidgets`) is the
 * next-best guess; anything else is ambiguous and left to the caller.
 */
function preferredScheme(schemes: readonly string[], target: string): string | undefined {
  const base = target.replace(/\.(xcodeproj|xcworkspace)$/i, '');
  if (base.length === 0) return undefined;
  const lower = base.toLowerCase();
  return (
    schemes.find((scheme) => scheme === base) ??
    schemes.find((scheme) => scheme.toLowerCase() === lower) ??
    schemes.find((scheme) => scheme.toLowerCase().startsWith(lower))
  );
}

/** Resolve the working directory for a tool call. */
function resolveCwd(config: HelperConfig, requested: unknown): string {
  if (isNonEmptyString(requested)) return requested;
  if (config.workspaceRoot.length > 0) return config.workspaceRoot;
  return process.cwd();
}

/** Read the runtime-grouped device map from a `simctl ... -j` document. */
function deviceGroups(document: Record<string, any>): Record<string, Array<Record<string, unknown>>> {
  const devices = document.devices;
  return devices !== null && typeof devices === 'object' ? (devices as Record<string, Array<Record<string, unknown>>>) : {};
}

/** Render a `simctl list devices -j` document into compact text. */
function formatDevices(document: Record<string, any>, runtimeFilter?: string): string {
  const lines: string[] = [];
  for (const [runtime, devices] of Object.entries(deviceGroups(document))) {
    if (runtimeFilter !== undefined && !runtime.toLowerCase().includes(runtimeFilter.toLowerCase())) continue;
    lines.push(`## ${runtime.replace('com.apple.CoreSimulator.SimRuntime.', '')}`);
    for (const device of devices) {
      if (device.isAvailable === false) continue;
      const name = String(device.name ?? '?');
      const udid = String(device.udid ?? '?');
      const state = String(device.state ?? '?');
      lines.push(`- ${name} [${state}] ${udid}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'no matching simulators';
}

/**
 * Names of every currently booted simulator.
 *
 * `simctl list devices booted -j` only ever reports booted devices, so any entry
 * here is state a test run has to contend with.
 */
async function bootedSimulatorNames(ctx: Ctx, config: HelperConfig, cwd: string): Promise<string[]> {
  const listed = await runCommand(ctx, config, {
    argv: [config.xcrunPath, 'simctl', 'list', 'devices', 'booted', '-j'],
    cwd,
    timeoutMs: config.simctlTimeoutMs,
  });
  const document = parseJsonObject(listed.output);
  if (document === undefined) return [];
  return Object.values(deviceGroups(document))
    .flat()
    .map((device) => String(device.name ?? device.udid ?? ''))
    .filter(isNonEmptyString);
}

/** Resolve a simulator selector (UDID, `booted`, or a device name) to a UDID. */
async function resolveDevice(
  ctx: Ctx,
  config: HelperConfig,
  cwd: string,
  requested: unknown,
): Promise<{ udid?: string; note?: string }> {
  if (!isNonEmptyString(requested)) {
    const booted = await runCommand(ctx, config, {
      argv: [config.xcrunPath, 'simctl', 'list', 'devices', 'booted', '-j'],
      cwd,
      timeoutMs: config.simctlTimeoutMs,
    });
    const document = parseJsonObject(booted.output);
    if (document === undefined) return { note: bounded(booted.output, 2000).text };
    const devices = Object.values(deviceGroups(document)).flat();
    const first = devices[0];
    if (first === undefined) return { note: 'no booted simulator; boot one with simulator_control first' };
    return { udid: String(first.udid) };
  }

  const selector = requested.trim();
  if (/^[0-9A-Fa-f-]{36}$/.test(selector)) return { udid: selector };
  if (selector === 'booted') return resolveDevice(ctx, config, cwd, undefined);

  const listed = await runCommand(ctx, config, {
    argv: [config.xcrunPath, 'simctl', 'list', 'devices', 'available', '-j'],
    cwd,
    timeoutMs: config.simctlTimeoutMs,
  });
  const document = parseJsonObject(listed.output);
  if (document === undefined) return { note: bounded(listed.output, 2000).text };
  const matches: Array<Record<string, unknown>> = [];
  for (const devices of Object.values(deviceGroups(document))) {
    for (const device of devices) {
      if (device.isAvailable === false) continue;
      const name = String(device.name ?? '');
      if (name === selector) matches.push(device);
      else if (matches.length === 0 && name.toLowerCase() === selector.toLowerCase()) matches.push(device);
    }
  }
  // Prefer an already-booted match so repeated calls target the same device.
  const booted = matches.find((device) => String(device.state) === 'Booted') ?? matches[0];
  if (booted === undefined) return { note: `no available simulator matches \`${selector}\`` };
  return { udid: String(booted.udid) };
}

/**
 * The slice of the `attachments` Service this plugin uses.
 *
 * It is an *optional* dependency: the tool reaches it through `ctx.get`, so a
 * profile without the service simply keeps the file-path behaviour instead of
 * failing to activate.
 */
interface AttachmentsLike {
  saveImage(input: {
    data: Uint8Array;
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    name?: string;
  }): Promise<Record<string, unknown>>;
}

/** Resolve the optional `attachments` Service, or undefined when unavailable. */
function attachmentsOf(ctx: Ctx): AttachmentsLike | undefined {
  const service = ctx.get('attachments');
  if (service === null || typeof service !== 'object') return undefined;
  return typeof (service as { saveImage?: unknown }).saveImage === 'function'
    ? (service as AttachmentsLike)
    : undefined;
}

/** Describe a caught value, keeping any stable service error code. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

/**
 * `log stream` predicate selecting exactly the Error (logType 16) and Fault
 * (logType 17) message types.
 *
 * The filter runs inside the simulator's `log` process, not after the fact: an
 * unfiltered `--level=debug` stream emits roughly 600 KB every five seconds
 * (measured on this project's simulator), while this predicate reduces the same
 * window to a handful of lines. Keeping it server-side is what makes a short
 * capture window affordable.
 */
const ERROR_FAULT_PREDICATE = 'messageType == error OR messageType == fault';

/** Longest single log message kept; one runaway line must not dominate the result. */
const MAX_LOG_MESSAGE_CHARS = 400;

/**
 * `xcodebuild` actions that run or prepare tests, and therefore honour
 * `-only-testing`. Any other action ignores the flag, which is worth saying out
 * loud rather than silently producing an unfiltered build.
 */
const TEST_ACTIONS: ReadonlySet<string> = new Set(['test', 'test-without-building', 'build-for-testing']);

/**
 * `xcodebuild` actions that actually *run* tests rather than only preparing them.
 * These are the actions a booted simulator can interfere with, and the only ones
 * where "zero tests executed" is a meaningful signal.
 */
const RUNS_TESTS: ReadonlySet<string> = new Set(['test', 'test-without-building']);

/** One `log stream --style=ndjson` record reduced to what is worth reporting. */
interface LogEntry {
  time: string;
  level: string;
  process: string;
  scope: string;
  message: string;
}

/**
 * Reduce `log stream --style=ndjson` output to its newest Error/Fault entries.
 *
 * Non-JSON lines are skipped on purpose: `log` prints a banner naming the
 * resolved predicate, and the merged stderr contributes lines too.
 */
function parseLogEntries(output: string, limit: number): { entries: LogEntry[]; matched: number } {
  const matched: LogEntry[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== '{') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const level = typeof record.messageType === 'string' ? record.messageType : '';
    if (!/^(error|fault)$/i.test(level)) continue;

    const rawTimestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
    // `YYYY-MM-DD HH:MM:SS.ffffff+ZZZZ` -> `HH:MM:SS.mmm`
    const time = rawTimestamp.length >= 23 ? rawTimestamp.slice(11, 23) : rawTimestamp;
    const imagePath = typeof record.processImagePath === 'string' ? record.processImagePath : '';
    const scopes = [record.subsystem, record.category].filter(isNonEmptyString);
    const message = typeof record.eventMessage === 'string' ? record.eventMessage : '';
    matched.push({
      time,
      level,
      process: imagePath.length > 0 ? basename(imagePath) : 'unknown',
      scope: scopes.join('/'),
      message:
        message.length <= MAX_LOG_MESSAGE_CHARS
          ? message
          : `${message.slice(0, MAX_LOG_MESSAGE_CHARS)}… (${message.length - MAX_LOG_MESSAGE_CHARS} more chars)`,
    });
  }
  // The newest entries are the interesting ones, so keep the tail.
  return { entries: matched.slice(-limit), matched: matched.length };
}

/** Render one log entry as a single compact line. */
function formatLogEntry(entry: LogEntry): string {
  const scope = entry.scope.length > 0 ? ` [${entry.scope}]` : '';
  return `${entry.time} ${entry.level.toUpperCase()} ${entry.process}${scope}: ${entry.message}`;
}

/**
 * Expand a leading `~` to the home directory.
 *
 * `spawn` performs no shell expansion, so a configured `~/...` path would be
 * passed literally and fail to resolve.
 */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

/** One element from `idb ui describe-all`, reduced to what tapping needs. */
interface AccessibilityElement {
  label: string;
  uniqueId: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centre of an element, the point a tap should hit. */
function elementCentre(element: AccessibilityElement): { x: number; y: number } {
  return {
    x: Math.round(element.x + element.width / 2),
    y: Math.round(element.y + element.height / 2),
  };
}

/** Read a finite number from an unknown JSON field. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reduce `idb ui describe-all` JSON to the elements worth reporting.
 *
 * The payload is a flat array of accessibility nodes; `frame` is normally
 * present, but `AXFrame` (`"{{x, y}, {w, h}}"`) is kept as a fallback so a
 * format change degrades to missing elements rather than a thrown parse error.
 */
function parseAccessibilityElements(output: string): AccessibilityElement[] {
  const start = output.indexOf('[');
  if (start < 0) return [];
  let records: unknown;
  try {
    records = JSON.parse(output.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(records)) return [];

  const elements: AccessibilityElement[] = [];
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const node = record as Record<string, unknown>;
    let x: number | undefined;
    let y: number | undefined;
    let width: number | undefined;
    let height: number | undefined;
    const frame = node.frame;
    if (frame !== null && typeof frame === 'object') {
      const f = frame as Record<string, unknown>;
      x = numberOf(f.x);
      y = numberOf(f.y);
      width = numberOf(f.width);
      height = numberOf(f.height);
    }
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      const axFrame = typeof node.AXFrame === 'string' ? node.AXFrame : '';
      const parsed = /\{\{([-\d.]+),\s*([-\d.]+)\},\s*\{([-\d.]+),\s*([-\d.]+)\}\}/.exec(axFrame);
      if (parsed === null) continue;
      x = Number(parsed[1]);
      y = Number(parsed[2]);
      width = Number(parsed[3]);
      height = Number(parsed[4]);
    }
    if (width <= 0 || height <= 0) continue;
    elements.push({
      label: isNonEmptyString(node.AXLabel) ? node.AXLabel.trim() : '',
      uniqueId: isNonEmptyString(node.AXUniqueId) ? node.AXUniqueId.trim() : '',
      type: isNonEmptyString(node.type) ? node.type : 'Element',
      x,
      y,
      width,
      height,
    });
  }
  return elements;
}

/** Render one element as a compact, tappable line. */
function formatAccessibilityElement(element: AccessibilityElement): string {
  const centre = elementCentre(element);
  const id = element.uniqueId.length > 0 ? ` id=${JSON.stringify(element.uniqueId)}` : '';
  const label = element.label.length > 0 ? ` ${JSON.stringify(element.label)}` : '';
  return `${element.type}${label}${id} @ (${centre.x}, ${centre.y})`;
}

/**
 * Resolve a caller-supplied accessibility identifier to one element.
 *
 * Exact `AXUniqueId`, then exact label, then a case-insensitive label/id match,
 * then a substring match. Among several matches the smallest frame wins, because
 * a container and its child can share a label while only the child is the real
 * tap target.
 *
 * `Application` nodes are never matched: `describe-all` always reports the
 * foreground app as a full-screen element labelled with its name, so matching it
 * would tap the middle of the screen — never what a caller asking for "Watch"
 * means. Those nodes still appear in `simulator_elements` output for context.
 */
function findAccessibilityElement(
  elements: readonly AccessibilityElement[],
  wanted: string,
): AccessibilityElement | undefined {
  const target = wanted.trim();
  if (target.length === 0) return undefined;
  const lower = target.toLowerCase();
  const tappable = elements.filter((element) => element.type !== 'Application');
  const tiers: Array<(element: AccessibilityElement) => boolean> = [
    (element) => element.uniqueId === target,
    (element) => element.label === target,
    (element) => element.uniqueId.toLowerCase() === lower || element.label.toLowerCase() === lower,
    (element) => element.uniqueId.toLowerCase().includes(lower) || element.label.toLowerCase().includes(lower),
  ];
  for (const matches of tiers) {
    const candidates = tappable.filter(matches);
    if (candidates.length === 0) continue;
    return candidates.reduce((best, element) =>
      element.width * element.height < best.width * best.height ? element : best,
    );
  }
  return undefined;
}

/**
 * Read how many tests `xcodebuild` actually executed.
 *
 * A test action prints `Executed N test(s), with …` once per suite level, so the
 * largest value is the bundle total. `undefined` means the line never appeared —
 * the run failed before reporting, or the action does not run tests at all.
 *
 * This matters because a test action that matches nothing still exits 0 and
 * prints `** TEST SUCCEEDED **` with `Executed 0 tests`: without this count, a
 * typo in `onlyTesting` would read as a pass for tests that never ran.
 */
function countExecutedTests(output: string): number | undefined {
  let max: number | undefined;
  for (const match of output.matchAll(/Executed (\d+) tests?[,.]/g)) {
    const count = Number(match[1]);
    max = max === undefined ? count : Math.max(max, count);
  }
  return max;
}

/** A `ContentBlock`-shaped text block. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

/**
 * JSON Schema for the `ImageAttachmentRef` an `ImageBlock` carries, mirroring
 * the shape `attachments.saveImage` returns. Shared by every tool that attaches
 * a capture so the three of them cannot drift apart.
 */
const IMAGE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
    },
  },
} as const;

/**
 * `idb`'s companion registry. The path is hardcoded in the client
 * (`idb/common/constants.py`), with no environment override, so mirroring it is
 * the only way to repair it.
 */
const IDB_STATE_FILE_PATH = '/tmp/idb/state';

/**
 * Drop companion records whose domain socket no longer exists, and report how
 * many were dropped.
 *
 * `idb` is supposed to prune dead companions itself (`--no-prune-dead-companion`
 * turns that off), but a companion that dies without cleaning up — a Host
 * restart that reaps it, a reboot, a `kill` — leaves a record pointing at a
 * missing socket, and every later call then fails with
 * `Failed to connect to companion ... No such file or directory` instead of
 * spawning a fresh one. Only records whose socket file is provably gone are
 * removed, so a live companion is never touched.
 */
function pruneUnreachableIdbCompanions(): number {
  try {
    const raw = readFileSync(IDB_STATE_FILE_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 0;
    const reachable = parsed.filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { path?: unknown }).path === 'string' &&
        existsSync((entry as { path: string }).path),
    );
    const removed = parsed.length - reachable.length;
    if (removed > 0) writeFileSync(IDB_STATE_FILE_PATH, JSON.stringify(reachable));
    return removed;
  } catch {
    return 0;
  }
}

/**
 * A filesystem-safe, sortable timestamp for generated filenames, e.g.
 * `2026-10-03T21-35-04-123Z`. Millisecond precision keeps two captures in the
 * same second from overwriting each other.
 */
function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Build the plugin. */
export function apply(ctx: Ctx, rawConfig?: unknown): () => void {
  const config = resolveConfig(rawConfig);
  const disposers: Array<() => void> = [];

  /** Register one tool definition, keeping its disposer for teardown. */
  const register = (definition: Record<string, unknown>): void => {
    disposers.push(ctx.tools.register(definition));
  };

  /**
   * Run one `idb` invocation, healing a stale companion registry once.
   *
   * `idb` is the only route to touch injection: `simctl` exposes no tap. The
   * first call in a session also starts the `idb_companion` daemon, which is why
   * `idbTimeoutMs` is generous.
   */
  const runIdb = async (
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    notes?: string[],
  ): Promise<CommandResult> => {
    const invoke = (): Promise<CommandResult> =>
      runCommand(ctx, config, {
        argv: [expandHome(config.idbPath), ...args],
        cwd,
        timeoutMs: config.idbTimeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      });

    const first = await invoke();
    // A dead companion leaves a record behind; repair and retry exactly once.
    if (first.unavailable || first.exitCode === 0) return first;
    if (!/Failed to connect to companion/i.test(first.output)) return first;
    const removed = pruneUnreachableIdbCompanions();
    if (removed === 0) return first;
    notes?.push(
      `removed ${removed} unreachable companion record(s) from ${IDB_STATE_FILE_PATH} and retried`,
    );
    return invoke();
  };

  /**
   * Capture the booted screen to a PNG, verify the file really landed, and hand
   * it to the conversation when the `attachments` service is available.
   *
   * Shared by `simulator_screenshot` and the post-tap capture in
   * `simulator_tap`, so both write under `screenshotDir`, both refuse to trust a
   * zero exit code, and both degrade to the path when attaching is impossible.
   */
  const captureScreen = async (options: {
    cwd: string;
    udid: string;
    prefix: string;
    path?: string | undefined;
    attach: boolean;
    notes: string[];
    signal?: AbortSignal | undefined;
  }): Promise<
    | { ok: true; path: string; bytes: number; image?: Record<string, unknown> }
    | { ok: false; failure: string; path?: string; exitCode?: number }
  > => {
    const destination =
      options.path !== undefined
        ? isAbsolute(options.path)
          ? options.path
          : join(options.cwd, options.path)
        : join(options.cwd, config.screenshotDir, `${options.prefix}-${fileTimestamp()}.png`);

    // simctl will not create intermediate directories, so make them first.
    const directory = dirname(destination);
    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        failure: `could not create the screenshot directory ${directory}: ${describeError(error)}`,
        path: destination,
      };
    }

    const captured = await runCommand(ctx, config, {
      argv: [config.xcrunPath, 'simctl', 'io', options.udid, 'screenshot', destination],
      cwd: options.cwd,
      timeoutMs: config.simctlTimeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (captured.unavailable) return { ok: false, failure: captured.output, path: destination };
    if (captured.exitCode !== 0) {
      return {
        ok: false,
        failure: `screenshot failed: ${bounded(captured.output, 2000).text}`,
        path: destination,
        ...(captured.exitCode !== null ? { exitCode: captured.exitCode } : {}),
      };
    }

    // A zero exit code is not proof of a file: verify the PNG really landed.
    let bytes: number | undefined;
    try {
      bytes = statSync(destination).size;
    } catch {
      bytes = undefined;
    }
    if (bytes === undefined || bytes === 0) {
      return {
        ok: false,
        failure: `simctl reported success but no readable image is at ${destination}`,
        path: destination,
      };
    }

    // Attaching is best-effort: the service is optional, applies its own limits,
    // and a refusal must not fail a capture that already succeeded on disk.
    let image: Record<string, unknown> | undefined;
    if (options.attach) {
      const attachments = attachmentsOf(ctx);
      if (attachments === undefined) {
        options.notes.push('the `attachments` service is not available here, so only the path is returned');
      } else {
        try {
          const reference = await attachments.saveImage({
            data: readFileSync(destination),
            mediaType: 'image/png',
            name: basename(destination),
          });
          image = { ...reference };
        } catch (error) {
          options.notes.push(
            `could not attach the capture to this conversation: ${describeError(error)}; ` +
              'the file is still on disk at the path above',
          );
        }
      }
    }
    return { ok: true, path: destination, bytes, ...(image !== undefined ? { image } : {}) };
  };

  // ---------------------------------------------------------------------------
  // Capability 1: Xcode build
  // ---------------------------------------------------------------------------

  register({
    name: 'xcode_build',
    description:
      'Build, test, or clean an Xcode workspace/project with `xcodebuild`, then parse the compiler ' +
      'diagnostics out of the output. Omit `target` and `scheme` to auto-discover them from the ' +
      'working directory; a multi-scheme project picks the scheme named after the project. A test action ' +
      'can be narrowed with `onlyTesting`, whose identifiers are appended as `-only-testing:<id>`; a test ' +
      'action that executes no test at all is reported as a failure rather than a silent success, and a ' +
      'test action always reports already-booted simulators (pass `shutdown_simulators` to shut them down ' +
      'first, which this project needs to avoid random UI-test failures). Errors ' +
      'and warnings come back as `file:line:col: severity: message` bullets, and `xcodebuild`-level ' +
      'failures that carry no position (a missing scheme, an unmatched destination) as ' +
      '`<producer>: severity: message`.',
    // Concurrent xcodebuild runs interfere through the shared simulator and
    // DerivedData (this project measured flaky clones), so run exclusively.
    isConcurrencySafe: () => false,
    timeoutMs: config.buildTimeoutMs + 30000,
    // `parameters` is sent to the model provider verbatim, so it must be a real
    // object-rooted JSON Schema — never the author-facing property map. Both
    // OpenAI-style `parameters` and Anthropic-style `input_schema` require
    // `type: "object"` with `properties`/`required`; a bare property map is
    // rejected by the provider with a 400 before the model ever runs.
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['build', 'test', 'clean', 'build-for-testing', 'test-without-building'],
          description: 'The xcodebuild action. Defaults to `build`.',
        },
        target: {
          type: 'string',
          description: 'Path to a .xcworkspace or .xcodeproj. Auto-discovered in cwd when omitted.',
        },
        scheme: {
          type: 'string',
          description: 'Scheme name. The only scheme is used when the target exposes exactly one.',
        },
        configuration: {
          type: 'string',
          description: 'Build configuration, e.g. Debug or Release. Defaults to Debug.',
        },
        destination: {
          type: 'string',
          description:
            'Full -destination value, e.g. `platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5`. ' +
            'When omitted for a simulator action, one is composed from `simulator` and `os`.',
        },
        simulator: {
          type: 'string',
          description: 'Simulator device name used to compose a destination, e.g. `iPhone 17 Pro`.',
        },
        os: {
          type: 'string',
          description: 'Simulator OS version used to compose a destination, e.g. `26.5`.',
        },
        onlyTesting: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Test identifiers to constrain a test action to, each appended as `-only-testing:<id>`. ' +
            'Identifiers have the form `TestTarget[/TestClass[/TestMethod]]`, e.g. ' +
            '["LunisolarCalendarUITests"] or ["LunisolarCalendarUITests/CalendarUITests/testLaunch"]. ' +
            'Repeat the array to constrain several identifiers. Only meaningful for the test actions ' +
            '(`test`, `test-without-building`, `build-for-testing`).',
        },
        shutdown_simulators: {
          type: 'boolean',
          description:
            'Before a test action, run `xcrun simctl shutdown all` so `xcodebuild` boots its own simulator ' +
            'from a clean state. Defaults to false, where the tool only warns when simulators are already ' +
            'booted. Measured on this project: a UI channel run with leftover simulator state produced ' +
            'random single-test failures that read as business bugs, so passing true is the safe choice ' +
            'before UI tests — note that it does shut down simulators you may be using interactively.',
        },
        derived_data_path: {
          type: 'string',
          description:
            'Per-call -derivedDataPath override, absolute or relative to `cwd`. Wins over the plugin ' +
            'config `derivedDataPath` (default `.dsh/DerivedData` under the workspace).',
        },
        extra_args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional raw arguments appended to the xcodebuild invocation.',
        },
        cwd: {
          type: 'string',
          description: 'Directory to run in. Defaults to the plugin working directory.',
        },
      },
    },
    // `output.schema` is a compiled JSON Schema, not the author DSL: requiredness
    // at the object root is a `required: [...]` array. A nested `required: true`
    // is only legal inside the `properties` map of an object node.
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'command', 'errorCount', 'warningCount', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          command: { type: 'string' },
          target: { type: 'string' },
          scheme: { type: 'string' },
          destination: { type: 'string' },
          exitCode: { type: 'integer' },
          derivedDataPath: { type: 'string' },
          executedTests: { type: 'integer' },
          errorCount: { type: 'integer' },
          warningCount: { type: 'integer' },
          diagnostics: { type: 'string' },
          outputTail: { type: 'string' },
          notes: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      render(
        _args: unknown,
        value: { summary: string; diagnostics?: string; notes?: unknown; outputTail?: string },
      ): unknown[] {
        // The structured `notes` array is part of the declared output, but the
        // model only ever sees these content blocks — so anything it must act on
        // (which scheme was auto-selected, a warnings-are-fatal verdict, a
        // timeout, dropped output) has to be rendered here or it is invisible.
        const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
        const parts = [
          value.summary,
          value.diagnostics,
          notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
          value.outputTail,
        ].filter(isNonEmptyString);
        const text = parts.join('\n\n');
        return [textBlock(text.length > 0 ? text : 'xcodebuild finished with no output')];
      },
    },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];
      const started = Date.now();

      let target = isNonEmptyString(args.target) ? args.target.trim() : undefined;
      let scheme = isNonEmptyString(args.scheme) ? args.scheme.trim() : undefined;

      if (target === undefined || scheme === undefined) {
        const discovered = await discoverProject(ctx, config, cwd);
        if (discovered.detectionLog.length > 0) notes.push(discovered.detectionLog);
        if (target === undefined) {
          target = discovered.target;
          if (target !== undefined) notes.push(`auto-discovered target: ${target}`);
        }
        if (scheme === undefined) {
          if (discovered.schemes.length === 1) {
            scheme = discovered.schemes[0];
            notes.push(`auto-selected the only scheme: ${scheme}`);
          } else if (discovered.schemes.length > 1) {
            // A one-click build must not stall on a multi-scheme project. Prefer
            // the scheme that names the target itself — Xcode's convention is
            // that the app target's scheme matches the project/workspace name,
            // and only when nothing matches is a human choice really required.
            const preferred =
              target !== undefined ? preferredScheme(discovered.schemes, target) : undefined;
            if (preferred !== undefined) {
              scheme = preferred;
              notes.push(
                `auto-selected scheme: ${scheme} (matches ${target}); ` +
                  `pass \`scheme\` to build another one of: ${discovered.schemes.join(', ')}`,
              );
            } else {
              return {
                ok: false,
                summary:
                  `No scheme matches ${target}. Pass \`scheme\` explicitly. ` +
                  `Available: ${discovered.schemes.join(', ')}`,
                command: 'xcodebuild -list',
                errorCount: 0,
                warningCount: 0,
                notes,
              };
            }
          }
        }
        if (discovered.diagnostics.length > 0) notes.push(bounded(discovered.diagnostics, 2000).text);
      }

      if (target === undefined) {
        return {
          ok: false,
          summary: `No .xcworkspace or .xcodeproj found in ${cwd}. Pass \`target\` explicitly.`,
          command: 'xcodebuild',
          errorCount: 0,
          warningCount: 0,
          notes,
        };
      }

      const action = isNonEmptyString(args.action) ? args.action.trim() : 'build';
      const configuration = isNonEmptyString(args.configuration) ? args.configuration.trim() : 'Debug';
      const flag = target.endsWith('.xcworkspace') ? '-workspace' : '-project';

      // `onlyTesting` constrains a test action to specific identifiers. The
      // earlier `only_testing` spelling stays accepted so an existing caller does
      // not break, but the camelCase name is the documented one.
      const rawOnlyTesting = args.onlyTesting ?? args.only_testing;
      let onlyTesting: string[] = [];
      if (rawOnlyTesting !== undefined) {
        const rejected = {
          ok: false,
          command: 'xcodebuild',
          target,
          errorCount: 0,
          warningCount: 0,
          notes,
        };
        if (!Array.isArray(rawOnlyTesting)) {
          return {
            ...rejected,
            summary: '`onlyTesting` must be an array of test identifiers, e.g. ["LunisolarCalendarUITests"]',
          };
        }
        const malformed = rawOnlyTesting.filter((entry) => !isNonEmptyString(entry)).length;
        if (malformed > 0) {
          return {
            ...rejected,
            summary:
              `every \`onlyTesting\` entry must be a non-empty string; ` +
              `${malformed} entr${malformed === 1 ? 'y is' : 'ies are'} not`,
          };
        }
        onlyTesting = [...new Set(rawOnlyTesting.map((entry) => (entry as string).trim()))];
        if (onlyTesting.length === 0) {
          return {
            ...rejected,
            summary: '`onlyTesting` was empty; list at least one test identifier, or omit the argument',
          };
        }
      }

      const argv: string[] = [config.xcodebuildPath, action, flag, target];
      if (scheme !== undefined) argv.push('-scheme', scheme);

      let destination = isNonEmptyString(args.destination) ? args.destination.trim() : undefined;
      const needsDestination = action !== 'clean' && action !== 'build-for-testing';
      if (destination === undefined && needsDestination) {
        const simulator = isNonEmptyString(args.simulator) ? args.simulator.trim() : undefined;
        const os = isNonEmptyString(args.os) ? args.os.trim() : undefined;
        if (simulator !== undefined) {
          destination =
            os !== undefined
              ? `platform=iOS Simulator,name=${simulator},OS=${os}`
              : `platform=iOS Simulator,name=${simulator}`;
        }
      }
      if (destination !== undefined) argv.push('-destination', destination);

      // `xcodebuild` accepts both `-only-testing <id>` and `-only-testing:<id>`;
      // the joined form is the one this repository's Tools/run_tests.sh uses.
      for (const identifier of onlyTesting) argv.push(`-only-testing:${identifier}`);
      if (onlyTesting.length > 0 && !TEST_ACTIONS.has(action)) {
        notes.push(
          `\`onlyTesting\` only constrains test actions; the \`${action}\` action ignores it`,
        );
      }
      // DerivedData decides whether repeat builds are incremental. Precedence:
      // the per-call argument, then the configured path, then the built-in
      // default. An explicit choice (argument or config) is always honoured, even
      // before the directory exists — `xcodebuild` creates it. The default is
      // only applied once `<cwd>/.dsh/DerivedData` actually exists, so a build
      // never silently starts writing products somewhere new.
      //
      // The path is a single argv element: no shell parses this command, so
      // quoting it (`-derivedDataPath "<path>"`) would literally embed quotes in
      // the path and break the build.
      const requestedDerivedData = isNonEmptyString(args.derived_data_path)
        ? args.derived_data_path.trim()
        : config.derivedDataPath;
      const derivedDataIsExplicit =
        isNonEmptyString(args.derived_data_path) || config.derivedDataPathConfigured;
      const derivedDataPath =
        requestedDerivedData.length === 0
          ? undefined
          : isAbsolute(requestedDerivedData)
            ? requestedDerivedData
            : join(cwd, requestedDerivedData);

      let usedDerivedData: string | undefined;
      if (derivedDataPath !== undefined) {
        if (derivedDataIsExplicit) {
          usedDerivedData = derivedDataPath;
          notes.push(`using the configured DerivedData path: ${derivedDataPath}`);
        } else if (existsSync(derivedDataPath)) {
          usedDerivedData = derivedDataPath;
          notes.push(`using the existing DerivedData path for incremental builds: ${derivedDataPath}`);
        }
      }
      if (usedDerivedData !== undefined) argv.push('-derivedDataPath', usedDerivedData);

      if (Array.isArray(args.extra_args)) {
        for (const entry of args.extra_args) {
          if (isNonEmptyString(entry)) argv.push(entry);
        }
      }

      // This repository's UI channels are documented to flake unless every
      // simulator is shut down first: leftover simulator state produced random
      // single-test failures that read as business bugs. Either perform that
      // shutdown on request, or at least say the trap is armed — never silently
      // run a UI channel against a dirty simulator.
      if (RUNS_TESTS.has(action)) {
        if (args.shutdown_simulators === true) {
          const shutdown = await runCommand(ctx, config, {
            argv: [config.xcrunPath, 'simctl', 'shutdown', 'all'],
            cwd,
            timeoutMs: config.simctlTimeoutMs,
          });
          if (shutdown.exitCode === 0) {
            notes.push(
              'ran `simctl shutdown all` first (shutdown_simulators: true), so xcodebuild boots a clean simulator',
            );
          } else {
            notes.push(`\`simctl shutdown all\` did not succeed: ${bounded(shutdown.output, 400).text}`);
          }
        } else {
          const booted = await bootedSimulatorNames(ctx, config, cwd);
          if (booted.length > 0) {
            notes.push(
              `${booted.length} simulator(s) are already booted (${booted.join(', ')}); this project's UI ` +
                'channels flake on leftover or parallel simulator state, which surfaces as random single-test ' +
                'failures that look like business bugs — pass `shutdown_simulators: true` to shut them down first',
            );
          }
        }
      }

      const result = await runCommand(ctx, config, {
        argv,
        cwd,
        timeoutMs: config.buildTimeoutMs,
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      });
      const command = argv.join(' ');
      const diagnostics = parseDiagnostics(result.output, config.maxDiagnostics);
      const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
      const warningCount = diagnostics.filter((item) => item.severity === 'warning').length;
      const tail = boundedTail(result.output, config.maxOutputChars);

      if (result.unavailable) {
        return {
          ok: false,
          summary: result.output,
          command,
          target,
          ...(scheme !== undefined ? { scheme } : {}),
          errorCount: 0,
          warningCount: 0,
          notes,
        };
      }

      if (result.timedOut) notes.push(`xcodebuild exceeded ${config.buildTimeoutMs} ms and was terminated`);
      if (result.lossy) notes.push('build output overflowed the in-memory budget and some output was dropped');
      if (result.exitCode !== 0 && diagnostics.length === 0) {
        notes.push(
          'xcodebuild exited nonzero but no diagnostic line matched; the cause is in the output tail below',
        );
      }
      const warningsAreFatal = config.treatWarningsAsErrors && warningCount > 0;
      if (warningsAreFatal) {
        notes.push(
          'this project treats compiler warnings as failures (treatWarningsAsErrors); ' +
            'set treatWarningsAsErrors: false in the plugin config to relax it',
        );
      }

      // A test action that filters every test away still exits 0 with
      // `** TEST SUCCEEDED **`; treat "nothing ran" as the failed request it is,
      // otherwise a typo in `onlyTesting` looks like a green run.
      const executedTests = countExecutedTests(result.output);
      const runsTests = RUNS_TESTS.has(action);
      const noTestsRan = runsTests && executedTests === 0;
      if (noTestsRan) {
        notes.push(
          'xcodebuild reported success but executed 0 tests — the `onlyTesting` identifiers matched ' +
            'nothing, so check the spelling against `xcodebuild -list` / the test navigator',
        );
      }
      if (runsTests && executedTests !== undefined) {
        notes.push(`xcodebuild executed ${executedTests} test(s)`);
      }

      const ok = result.exitCode === 0 && errorCount === 0 && !warningsAreFatal && !result.timedOut && !noTestsRan;
      const elapsed = Math.round((Date.now() - started) / 1000);
      const verdict = noTestsRan
        ? `xcodebuild ${action} ran no tests in ${elapsed}s`
        : ok
          ? `xcodebuild ${action} succeeded in ${elapsed}s`
          : result.timedOut
            ? `xcodebuild ${action} was terminated after ${config.buildTimeoutMs} ms`
          : `xcodebuild ${action} failed (exit ${result.exitCode ?? result.signal ?? 'unknown'}) after ${elapsed}s`;
      const counts = `${errorCount} error(s), ${warningCount} warning(s) parsed`;

      return {
        ok,
        summary: `${verdict} — ${counts}`,
        command,
        target,
        ...(scheme !== undefined ? { scheme } : {}),
        ...(destination !== undefined ? { destination } : {}),
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        ...(usedDerivedData !== undefined ? { derivedDataPath: usedDerivedData } : {}),
        ...(executedTests !== undefined ? { executedTests } : {}),
        errorCount,
        warningCount,
        ...(diagnostics.length > 0 ? { diagnostics: formatDiagnostics(diagnostics) } : {}),
        outputTail: `--- last ${config.maxOutputChars} chars of build output ---\n${tail.text}`,
        notes,
      };
    },
  });

  register({
    name: 'xcode_info',
    description:
      'Inspect the Xcode project next to the current directory: the workspace/project path and its ' +
      'schemes and configurations, plus the available simulator runtimes. Call this before a first ' +
      '`xcode_build` when you do not know the scheme name.',
    isConcurrencySafe: () => true,
    timeoutMs: 180000,
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Directory to inspect. Defaults to the plugin working directory.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'schemes', 'configurations', 'runtimes', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          target: { type: 'string' },
          schemes: { type: 'array', items: { type: 'string' } },
          configurations: { type: 'array', items: { type: 'string' } },
          runtimes: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args: unknown, value: { summary: string }): unknown[] {
        return [textBlock(value.summary)];
      },
    },
    async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];
      const discovered = await discoverProject(ctx, config, cwd);
      const runtimes = await runCommand(ctx, config, {
        argv: [config.xcrunPath, 'simctl', 'list', 'runtimes', '-j'],
        cwd,
        timeoutMs: config.simctlTimeoutMs,
      });
      const runtimeNames: string[] = [];
      const runtimesDocument = parseJsonObject(runtimes.output);
      if (runtimesDocument === undefined) {
        if (runtimes.output.trim().length > 0) notes.push('could not parse `simctl list runtimes -j` output');
      } else {
        const list = runtimesDocument.runtimes;
        for (const runtime of Array.isArray(list) ? list : []) {
          if (runtime.isAvailable === false) continue;
          const name = String(runtime.name ?? '');
          const version = String(runtime.version ?? '');
          runtimeNames.push(version.length > 0 ? `${name} (${version})` : name);
        }
      }
      if (discovered.schemes.length === 0) notes.push('no schemes were discovered');
      const lines = [
        `target: ${discovered.target ?? '(none found in ' + cwd + ')'}`,
        `schemes: ${discovered.schemes.length > 0 ? discovered.schemes.join(', ') : '(none)'}`,
        `runtimes: ${runtimeNames.length > 0 ? runtimeNames.join(', ') : '(none)'}`,
      ];
      if (discovered.diagnostics.length > 0) notes.push(bounded(discovered.diagnostics, 1500).text);
      return {
        ok: discovered.target !== undefined,
        summary: lines.join('\n'),
        ...(discovered.target !== undefined ? { target: discovered.target } : {}),
        schemes: discovered.schemes,
        configurations: ['Debug', 'Release'],
        runtimes: runtimeNames,
        notes,
      };
    },
  });

  register({
    name: 'ios_dependencies',
    description:
      'Resolve an iOS project\'s dependencies before a first build. Detects `Podfile` and `Package.swift` in ' +
      'the working directory (usually the workspace root) and runs the matching command: `pod install` for ' +
      'CocoaPods, `swift package resolve` for SwiftPM. Both are run when both manifests exist. Each command ' +
      'gets `dependenciesTimeoutMs` (default 5 minutes); a missing CLI or a timeout is reported as a failure ' +
      'rather than silently skipped.',
    isConcurrencySafe: () => false,
    timeoutMs: 20 * 60 * 1000,
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description:
            'Directory holding the manifests. Defaults to the plugin working directory (the configured ' +
            '`workspaceRoot`, i.e. the repository root).',
        },
        timeout_ms: {
          type: 'number',
          description:
            'Per-command budget in milliseconds. Defaults to `dependenciesTimeoutMs` (300000, i.e. 5 ' +
            'minutes), clamped to 1000–3600000.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          manifests: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['manager', 'manifest', 'command', 'ok', 'elapsedMs'],
              properties: {
                manager: { type: 'string' },
                manifest: { type: 'string' },
                command: { type: 'string' },
                ok: { type: 'boolean' },
                exitCode: { type: 'integer' },
                elapsedMs: { type: 'integer' },
                output: { type: 'string' },
              },
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args: unknown, value: { summary: string; results?: unknown; notes?: unknown }): unknown[] {
        const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
        const blocks: string[] = [];
        const results = Array.isArray(value.results) ? value.results : [];
        for (const entry of results) {
          if (entry === null || typeof entry !== 'object') continue;
          const record = entry as Record<string, unknown>;
          const verdict = record.ok === true ? 'ok' : 'FAILED';
          blocks.push(
            `${String(record.manager)} (${String(record.manifest)}) — ${verdict}` +
              `${record.exitCode !== undefined ? ` exit=${String(record.exitCode)}` : ''}` +
              ` in ${Math.round(Number(record.elapsedMs ?? 0) / 1000)}s\n$ ${String(record.command)}` +
              (isNonEmptyString(record.output) ? `\n--- last output ---\n${record.output}` : ''),
          );
        }
        const parts = [
          value.summary,
          blocks.join('\n\n'),
          notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
        ].filter(isNonEmptyString);
        return [textBlock(parts.join('\n\n'))];
      },
    },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];
      const timeoutMs = Math.floor(
        positiveNumber(args.timeout_ms, config.dependenciesTimeoutMs, 1000, 60 * 60 * 1000),
      );

      // Auto-detect by manifest file, not by a flag: whichever a project uses is
      // already on disk. A project may legitimately carry both (a Podfile plus a
      // local SwiftPM package), so each detected manifest gets its command.
      const plans: Array<{
        manager: string;
        manifest: string;
        executable: string;
        configKey: string;
        argv: string[];
      }> = [];
      if (existsSync(join(cwd, 'Podfile'))) {
        const executable = expandHome(config.podPath);
        plans.push({
          manager: 'CocoaPods',
          manifest: 'Podfile',
          executable,
          configKey: 'podPath',
          argv: [executable, 'install'],
        });
      }
      if (existsSync(join(cwd, 'Package.swift'))) {
        const executable = expandHome(config.swiftPath);
        plans.push({
          manager: 'SwiftPM',
          manifest: 'Package.swift',
          executable,
          configKey: 'swiftPath',
          argv: [executable, 'package', 'resolve'],
        });
      }

      if (plans.length === 0) {
        return {
          ok: false,
          summary:
            `neither a Podfile nor a Package.swift exists in ${cwd}; nothing to resolve. ` +
            'Pass `cwd` if the manifest lives in a subdirectory.',
          results: [],
          notes,
        };
      }

      const results: Array<Record<string, unknown>> = [];
      for (const plan of plans) {
        const command = plan.argv.join(' ');
        const started = Date.now();
        const outcome = await runCommand(ctx, config, {
          argv: plan.argv,
          cwd,
          timeoutMs,
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        });
        const elapsedMs = Date.now() - started;

        if (outcome.unavailable) {
          // A tool that is not installed is a real failure with a real fix, not a
          // silent skip: shipping a "resolve" that resolves nothing is worse than
          // an error naming the missing binary.
          notes.push(`${plan.manager}: ${outcome.output}`);
          results.push({
            manager: plan.manager,
            manifest: plan.manifest,
            command,
            ok: false,
            elapsedMs,
            output: bounded(outcome.output, 1000).text,
          });
          continue;
        }

        if (outcome.timedOut) notes.push(`${command} exceeded ${timeoutMs} ms and was terminated`);
        if (outcome.lossy) {
          notes.push(`${plan.manager} output overflowed the in-memory budget and some output was dropped`);
        }

        // A process that never started reports no exit status and no signal: the
        // executor could not launch it, which almost always means the CLI is
        // absent. Say that outright — "failed in 0s" with empty output would hide
        // the one thing the caller needs to fix.
        const launched = outcome.exitCode !== null || outcome.timedOut;
        if (!launched && outcome.signal === null) {
          notes.push(
            `${plan.manager}: \`${plan.executable}\` could not be launched — it is not installed or not on ` +
              `PATH. Install it, or set \`${plan.configKey}\` in the plugin config to its absolute path.`,
          );
        }

        const tail = boundedTail(outcome.output, config.maxOutputChars);
        if (tail.truncated) {
          notes.push(`${plan.manager}: showing the last ${config.maxOutputChars} characters of the output`);
        }
        const explanation = !launched
          ? `\`${plan.executable}\` produced no output and no exit status, so it never started`
          : '';

        results.push({
          manager: plan.manager,
          manifest: plan.manifest,
          command,
          ok: outcome.exitCode === 0 && !outcome.timedOut,
          ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
          elapsedMs,
          ...(tail.text.length > 0
            ? { output: tail.text }
            : explanation.length > 0
              ? { output: explanation }
              : {}),
        });
      }

      const failed = results.filter((entry) => entry.ok !== true);
      const verdicts = results.map((entry) => {
        const state =
          entry.ok === true
            ? 'ok'
            : `failed${entry.exitCode !== undefined ? ` (exit ${String(entry.exitCode)})` : ''}`;
        return `${String(entry.manager)}: ${state} in ${Math.round(Number(entry.elapsedMs) / 1000)}s`;
      });

      return {
        ok: failed.length === 0,
        summary: `resolved dependencies in ${cwd} — ${verdicts.join('; ')}`,
        manifests: plans.map((plan) => plan.manifest).join(', '),
        results,
        notes,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Capability 2: Simulator control
  // ---------------------------------------------------------------------------

  register({
    name: 'simulator_control',
    description:
      'Control iOS simulators through `xcrun simctl`: boot, shutdown, list devices, and inspect the ' +
      'currently booted device. `open` also brings the Simulator app to the front. Destructive ' +
      'actions (`erase`, `delete`) require `confirm: true`.',
    isConcurrencySafe: () => false,
    timeoutMs: config.simctlTimeoutMs + 30000,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'boot', 'shutdown', 'booted', 'open', 'erase', 'delete', 'runtime_list'],
          description: 'The simctl operation to perform.',
        },
        device: {
          type: 'string',
          description: 'Simulator name, UDID, or `booted`. Defaults to the booted device where meaningful.',
        },
        runtime: {
          type: 'string',
          description: 'Runtime substring filter for `list`, e.g. `iOS-27`. Only available devices are shown.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true for the destructive `erase` and `delete` actions.',
        },
        cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'summary', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          summary: { type: 'string' },
          device: { type: 'string' },
          udid: { type: 'string' },
          exitCode: { type: 'integer' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args: unknown, value: { summary: string }): unknown[] {
        return [textBlock(value.summary)];
      },
    },
    async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const action = isNonEmptyString(args.action) ? args.action.trim() : 'list';
      const notes: string[] = [];
      const run = (argv: string[]): Promise<CommandResult> =>
        runCommand(ctx, config, { argv: [config.xcrunPath, 'simctl', ...argv], cwd, timeoutMs: config.simctlTimeoutMs });

      if (action === 'list') {
        const runtimeFilter = isNonEmptyString(args.runtime) ? args.runtime.trim() : undefined;
        const listed = await run(['list', 'devices', 'available', '-j']);
        if (listed.unavailable) return { ok: false, action, summary: listed.output, notes };
        const document = parseJsonObject(listed.output);
        if (document === undefined) return { ok: false, action, summary: bounded(listed.output, 4000).text, notes };
        return { ok: true, action, summary: formatDevices(document, runtimeFilter), notes };
      }

      if (action === 'runtime_list') {
        const listed = await run(['list', 'runtimes']);
        return {
          ok: listed.exitCode === 0,
          action,
          summary: bounded(listed.output, 4000).text,
          notes,
        };
      }

      if (action === 'booted') {
        const resolved = await resolveDevice(ctx, config, cwd, undefined);
        if (resolved.udid === undefined) {
          return { ok: false, action, summary: resolved.note ?? 'no booted simulator', notes };
        }
        const described = await run(['list', 'devices', 'booted', '-j']);
        const document = parseJsonObject(described.output);
        let label = resolved.udid;
        if (document !== undefined) {
          const device = Object.values(deviceGroups(document)).flat()[0];
          if (device !== undefined) label = `${String(device.name)} [${String(device.state)}] ${resolved.udid}`;
        }
        return { ok: true, action, summary: `booted device: ${label}`, udid: resolved.udid, notes };
      }

      if ((action === 'erase' || action === 'delete') && args.confirm !== true) {
        return {
          ok: false,
          action,
          summary: `\`${action}\` is destructive; pass confirm: true to proceed`,
          notes,
        };
      }

      const resolved = await resolveDevice(ctx, config, cwd, args.device);
      if (resolved.udid === undefined) {
        return { ok: false, action, summary: resolved.note ?? 'no matching simulator', notes };
      }
      const udid = resolved.udid;

      if (action === 'open') {
        // `open -a Simulator` only fronts the UI; boot the device first so the
        // window actually shows this simulator.
        await run(['boot', udid]);
        const opened = await runCommand(ctx, config, {
          argv: ['/usr/bin/open', '-a', 'Simulator'],
          cwd,
          timeoutMs: 30000,
        });
        if (opened.exitCode !== 0) notes.push(bounded(opened.output, 500).text);
        return {
          ok: opened.exitCode === 0,
          action,
          summary: `opened Simulator with ${udid}`,
          udid,
          ...(opened.exitCode !== null ? { exitCode: opened.exitCode } : {}),
          notes,
        };
      }

      const simctlAction = action === 'boot' ? 'boot' : action;
      const result = await run([simctlAction, udid]);
      // Booting an already-booted device reports a benign "Unable to boot device
      // in current state: Booted"; treat that as success.
      const alreadyBooted = /current state:\s*Booted/i.test(result.output);
      if (alreadyBooted) notes.push('device was already in the requested state');
      const ok = result.exitCode === 0 || alreadyBooted;
      const summary = bounded(
        ok
          ? `${action} ${udid}: ${result.output.trim().length > 0 ? result.output.trim() : 'ok'}`
          : `${action} ${udid} failed: ${result.output.trim()}`,
        3000,
      ).text;
      return {
        ok,
        action,
        summary,
        udid,
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        notes,
      };
    },
  });

  register({
    name: 'simulator_install_launch',
    description:
      'Install a built `.app` bundle onto a simulator and launch it (`xcrun simctl install` + `launch`). ' +
      'Pass the `.app` product from an `xcode_build` run; `bundle_id` is required for launching and is ' +
      'optional when only installing.',
    isConcurrencySafe: () => false,
    timeoutMs: config.simctlTimeoutMs + 30000,
    parameters: {
      type: 'object',
      properties: {
        app_path: { type: 'string', description: 'Path to the built `.app` bundle.' },
        bundle_id: { type: 'string', description: 'Bundle identifier to launch, e.g. com.example.app.' },
        device: { type: 'string', description: 'Simulator name, UDID, or `booted`. Defaults to the booted device.' },
        launch: { type: 'boolean', description: 'Launch after installing. Defaults to true when bundle_id is given.' },
        terminate_existing: {
          type: 'boolean',
          description: 'Terminate a running instance before launching. Defaults to false.',
        },
        console: {
          type: 'boolean',
          description: 'Stream the app console to stdout via `launch --console-pty`. Defaults to false.',
        },
        arguments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Launch arguments passed to the app.',
        },
        cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
      },
      required: ['app_path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'appPath', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          appPath: { type: 'string' },
          bundleId: { type: 'string' },
          udid: { type: 'string' },
          pid: { type: 'integer' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args: unknown, value: { summary: string }): unknown[] {
        return [textBlock(value.summary)];
      },
    },
    async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];
      if (!isNonEmptyString(args.app_path)) {
        return { ok: false, summary: 'app_path is required', appPath: '', notes };
      }
      const appPath = args.app_path.trim();
      const bundleId = isNonEmptyString(args.bundle_id) ? args.bundle_id.trim() : undefined;
      const shouldLaunch = args.launch === false ? false : bundleId !== undefined;
      if (shouldLaunch && bundleId === undefined) {
        return { ok: false, summary: 'bundle_id is required to launch the app', appPath, notes };
      }

      const resolved = await resolveDevice(ctx, config, cwd, args.device);
      if (resolved.udid === undefined) {
        return { ok: false, summary: resolved.note ?? 'no matching simulator', appPath, notes };
      }
      const udid = resolved.udid;

      // Install and launch both require a booted device.
      const booted = await runCommand(ctx, config, {
        argv: [config.xcrunPath, 'simctl', 'boot', udid],
        cwd,
        timeoutMs: config.simctlTimeoutMs,
      });
      if (booted.exitCode !== 0 && !/current state:\s*Booted/i.test(booted.output)) {
        notes.push(`boot reported: ${bounded(booted.output, 300).text}`);
      }

      const installed = await runCommand(ctx, config, {
        argv: [config.xcrunPath, 'simctl', 'install', udid, appPath],
        cwd,
        timeoutMs: config.simctlTimeoutMs,
      });
      if (installed.exitCode !== 0) {
        return {
          ok: false,
          summary: `install failed: ${bounded(installed.output, 3000).text}`,
          appPath,
          udid,
          ...(bundleId !== undefined ? { bundleId } : {}),
          notes,
        };
      }
      const lines = [`installed ${appPath} on ${udid}`];
      if (!shouldLaunch || bundleId === undefined) {
        return { ok: true, summary: lines.join('\n'), appPath, udid, notes };
      }

      if (args.terminate_existing === true) {
        await runCommand(ctx, config, {
          argv: [config.xcrunPath, 'simctl', 'terminate', udid, bundleId],
          cwd,
          timeoutMs: config.simctlTimeoutMs,
        });
      }

      const launchArgv = [config.xcrunPath, 'simctl', 'launch'];
      if (args.console === true) launchArgv.push('--console-pty');
      launchArgv.push(udid, bundleId);
      if (Array.isArray(args.arguments)) {
        for (const entry of args.arguments) {
          if (isNonEmptyString(entry)) launchArgv.push(entry);
        }
      }
      const launched = await runCommand(ctx, config, {
        argv: launchArgv,
        cwd,
        timeoutMs: args.console === true ? config.simctlTimeoutMs * 4 : config.simctlTimeoutMs,
      });
      const pidMatch = /:\s*(\d+)\s*$/.exec(launched.output.trim());
      const pid = pidMatch !== null ? Number(pidMatch[1]) : undefined;
      const ok = launched.exitCode === 0 || pid !== undefined;
      lines.push(
        ok
          ? `launched ${bundleId}${pid !== undefined ? ` (pid ${pid})` : ''}`
          : `launch failed: ${bounded(launched.output, 2000).text}`,
      );
      return {
        ok,
        summary: lines.join('\n'),
        appPath,
        bundleId,
        udid,
        ...(pid !== undefined ? { pid } : {}),
        notes,
      };
    },
  });

  register({
    name: 'simulator_screenshot',
    description:
      'Capture the current screen of a booted iOS simulator to a PNG with ' +
      '`xcrun simctl io <device> screenshot`. The image lands in the workspace temp directory ' +
      `(config \`screenshotDir\`, default \`${config.screenshotDir}\`) under a timestamped name unless ` +
      '`path` overrides it. Returns the absolute path of the image; inspect the picture itself with ' +
      'the read_image tool.',
    isConcurrencySafe: () => false,
    timeoutMs: config.simctlTimeoutMs + 30000,
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Simulator name, UDID, or `booted`. Defaults to the booted device.',
        },
        path: {
          type: 'string',
          description:
            'Explicit destination file, absolute or relative to `cwd`. Defaults to ' +
            '`<cwd>/<screenshotDir>/screenshot-<timestamp>.png`.',
        },
        cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
        attach: {
          type: 'boolean',
          description:
            'Also attach the capture to this conversation as an image so it can be seen directly, ' +
            'instead of only returning its path. Defaults to true; the file is written either way.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          udid: { type: 'string' },
          exitCode: { type: 'integer' },
          image: IMAGE_REF_SCHEMA,
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(
        _args: unknown,
        value: { summary: string; path?: string; image?: unknown; notes?: unknown },
      ): unknown[] {
        const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
        const parts = [
          value.summary,
          notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
          // The absolute path is the whole point of the tool, so render it
          // rather than trusting the caller to read the structured field.
          isNonEmptyString(value.path) ? `image: ${value.path}` : undefined,
        ].filter(isNonEmptyString);
        const blocks: unknown[] = [textBlock(parts.join('\n\n'))];
        // An ImageBlock is what lets the model actually look at the capture.
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];

      const resolved = await resolveDevice(ctx, config, cwd, args.device);
      if (resolved.udid === undefined) {
        return {
          ok: false,
          summary: resolved.note ?? 'no booted simulator; boot one with simulator_control first',
          notes,
        };
      }
      const udid = resolved.udid;

      const captured = await captureScreen({
        cwd,
        udid,
        prefix: 'screenshot',
        path: isNonEmptyString(args.path) ? args.path.trim() : undefined,
        attach: args.attach !== false,
        notes,
      });
      if (!captured.ok) {
        return {
          ok: false,
          summary: captured.failure,
          ...(captured.path !== undefined ? { path: captured.path } : {}),
          udid,
          ...(captured.exitCode !== undefined ? { exitCode: captured.exitCode } : {}),
          notes,
        };
      }

      return {
        ok: true,
        summary: `captured ${udid} to ${captured.path} (${captured.bytes} bytes)`,
        path: captured.path,
        bytes: captured.bytes,
        udid,
        ...(captured.image !== undefined ? { image: captured.image } : {}),
        notes,
      };
    },
  });

  register({
    name: 'simulator_logs',
    description:
      'Listen to the booted simulator\'s unified log for a short window with ' +
      '`xcrun simctl spawn <device> log stream --level=debug`, then report only the `error` and ' +
      '`fault` entries, newest last. The stream never ends on its own, so it is stopped after ' +
      '`seconds` (default 5). The `error`/`fault` selection happens inside `log` itself, so the ' +
      'captured volume stays small, and the returned text is bounded to keep the context small.',
    isConcurrencySafe: () => false,
    // Covers the maximum 60 s window plus startup and shutdown.
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Simulator name, UDID, or `booted`. Defaults to the booted device.',
        },
        seconds: {
          type: 'number',
          description: 'How long to listen before stopping the stream. Defaults to 5, clamped to 1–60.',
        },
        max_lines: {
          type: 'number',
          description: 'How many of the newest matching entries to return. Defaults to 200, clamped to 1–2000.',
        },
        cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          logs: { type: 'string' },
          matched: { type: 'integer' },
          returned: { type: 'integer' },
          capturedBytes: { type: 'integer' },
          durationMs: { type: 'integer' },
          truncated: { type: 'boolean' },
          exitCode: { type: 'integer' },
          udid: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(
        _args: unknown,
        value: { summary: string; logs?: string; notes?: unknown },
      ): unknown[] {
        const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
        const parts = [
          value.summary,
          notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
          value.logs,
        ].filter(isNonEmptyString);
        return [textBlock(parts.join('\n\n'))];
      },
    },
    async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];

      const resolved = await resolveDevice(ctx, config, cwd, args.device);
      if (resolved.udid === undefined) {
        return {
          ok: false,
          summary: resolved.note ?? 'no booted simulator; boot one with simulator_control first',
          notes,
        };
      }
      const udid = resolved.udid;

      const seconds = positiveNumber(args.seconds, 5, 1, 60);
      const maxLines = Math.floor(positiveNumber(args.max_lines, 200, 1, 2000));
      const durationMs = Math.round(seconds * 1000);

      const result = await runCommand(ctx, config, {
        argv: [
          config.xcrunPath,
          'simctl',
          'spawn',
          udid,
          'log',
          'stream',
          // Kept as specified: with the predicate below, `--level` no longer
          // widens the result set, so this is the documented command shape.
          '--level=debug',
          // Machine-parsable records; the default style is human prose.
          '--style=ndjson',
          '--predicate',
          ERROR_FAULT_PREDICATE,
        ],
        cwd,
        timeoutMs: durationMs,
      });

      if (result.unavailable) {
        return { ok: false, summary: result.output, udid, notes };
      }
      // A window that ended because we stopped it is the normal path here; a
      // stream that exited *by itself* with a failure (a bad predicate, no such
      // device) is not.
      if (!result.timedOut && result.exitCode !== 0) {
        return {
          ok: false,
          summary: `log stream failed: ${bounded(result.output, 2000).text}`,
          udid,
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          notes,
        };
      }

      const { entries, matched } = parseLogEntries(result.output, maxLines);
      if (result.lossy) {
        notes.push('the capture overflowed its in-memory budget, so older entries may be missing');
      }
      if (matched === 0) {
        notes.push(`no error or fault entry was logged during the ${seconds}s window`);
      } else if (matched > entries.length) {
        notes.push(`kept the newest ${entries.length} of ${matched} matching entries`);
      }

      const text = entries.map(formatLogEntry).join('\n');
      const boundedText = boundedTail(text, config.maxOutputChars);
      if (boundedText.truncated) {
        notes.push(`the rendered log was trimmed to the newest ${config.maxOutputChars} characters`);
      }

      return {
        ok: true,
        summary:
          `listened ${seconds}s on ${udid} — ${matched} error/fault entry(ies), ` +
          `returning ${entries.length}`,
        ...(boundedText.text.length > 0 ? { logs: boundedText.text } : {}),
        matched,
        returned: entries.length,
        capturedBytes: Buffer.byteLength(result.output, 'utf8'),
        durationMs,
        ...(boundedText.truncated ? { truncated: true } : {}),
        udid,
        notes,
      };
    },
  });

  register({
    name: 'simulator_tap',
    description:
      'Tap the booted iOS simulator, either at an absolute screen point or on the element that owns an ' +
      'accessibility identifier. Taps are injected with `idb ui tap`, because `xcrun simctl` has no tap ' +
      'command at all. Coordinates are in points (the device\'s logical screen, e.g. 402x874 for an ' +
      'iPhone 17 Pro), not pixels; use simulator_elements to discover identifiers and their centres.',
    isConcurrencySafe: () => false,
    timeoutMs: 180000,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Absolute x coordinate in points. Required unless `accessibility_id` is given.' },
        y: { type: 'number', description: 'Absolute y coordinate in points. Required unless `accessibility_id` is given.' },
        accessibility_id: {
          type: 'string',
          description:
            'Accessibility identifier (AXUniqueId, or its label) of the element to tap. Its frame centre ' +
            'is tapped instead of `x`/`y`. Discover identifiers with simulator_elements.',
        },
        device: { type: 'string', description: 'Simulator name, UDID, or `booted`. Defaults to the booted device.' },
        cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
        screenshot: {
          type: 'boolean',
          description:
            'Capture the screen once the tap settles and attach it to this conversation, so the outcome ' +
            'is visible without a second call. Defaults to true; pass false to only tap.',
        },
        settle_ms: {
          type: 'number',
          description:
            'How long to wait after the tap before capturing, so an animation is not caught mid-flight. ' +
            'Defaults to 700, clamped to 0–10000.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          mode: { type: 'string', enum: ['coordinate', 'accessibility'] },
          x: { type: 'integer' },
          y: { type: 'integer' },
          element: { type: 'string' },
          screenshotPath: { type: 'string' },
          bytes: { type: 'integer' },
          image: IMAGE_REF_SCHEMA,
          udid: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(
        _args: unknown,
        value: {
          summary: string;
          notes?: unknown;
          x?: number;
          y?: number;
          element?: string;
          screenshotPath?: string;
          image?: unknown;
        },
      ): unknown[] {
        const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
        const parts = [
          value.summary,
          value.element !== undefined ? `element: ${value.element}` : undefined,
          value.x !== undefined && value.y !== undefined ? `tapped at: (${value.x}, ${value.y})` : undefined,
          notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
          isNonEmptyString(value.screenshotPath) ? `screenshot: ${value.screenshotPath}` : undefined,
        ].filter(isNonEmptyString);
        const blocks: unknown[] = [textBlock(parts.join('\n\n'))];
        // The post-tap capture is the point of the combined call: show it.
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];

      const accessibilityId = isNonEmptyString(args.accessibility_id) ? args.accessibility_id.trim() : undefined;
      const hasPoint = numberOf(args.x) !== undefined && numberOf(args.y) !== undefined;
      if (accessibilityId === undefined && !hasPoint) {
        return {
          ok: false,
          summary: 'pass either `x` and `y`, or `accessibility_id`',
          notes,
        };
      }

      const resolved = await resolveDevice(ctx, config, cwd, args.device);
      if (resolved.udid === undefined) {
        return {
          ok: false,
          summary: resolved.note ?? 'no booted simulator; boot one with simulator_control first',
          notes,
        };
      }
      const udid = resolved.udid;

      let x = hasPoint ? Math.round(numberOf(args.x) as number) : 0;
      let y = hasPoint ? Math.round(numberOf(args.y) as number) : 0;
      let mode: 'coordinate' | 'accessibility' = 'coordinate';
      let elementLine: string | undefined;

      if (accessibilityId !== undefined) {
        mode = 'accessibility';
        const described = await runIdb(['ui', 'describe-all', '--udid', udid], cwd, exec.signal, notes);
        if (described.unavailable) {
          return { ok: false, summary: described.output, notes };
        }
        if (described.exitCode !== 0) {
          return {
            ok: false,
            summary: `could not read the accessibility tree: ${bounded(described.output, 2000).text}`,
            udid,
            notes,
          };
        }
        const elements = parseAccessibilityElements(described.output);
        const match = findAccessibilityElement(elements, accessibilityId);
        if (match === undefined) {
          const known = elements
            .filter((element) => element.label.length > 0 || element.uniqueId.length > 0)
            .slice(0, 20)
            .map(formatAccessibilityElement);
          return {
            ok: false,
            summary:
              `no element matches ${JSON.stringify(accessibilityId)} among ${elements.length} elements; ` +
              'call simulator_elements for the full list',
            ...(known.length > 0 ? { notes: [...notes, `first candidates:\n${known.join('\n')}`] } : { notes }),
            udid,
          };
        }
        const centre = elementCentre(match);
        x = centre.x;
        y = centre.y;
        elementLine = `${formatAccessibilityElement(match)} [${match.width}x${match.height}]`;
      }

      const tapped = await runIdb(['ui', 'tap', String(x), String(y), '--udid', udid], cwd, exec.signal, notes);
      if (tapped.unavailable) {
        return { ok: false, summary: tapped.output, udid, notes };
      }
      if (tapped.exitCode !== 0) {
        return {
          ok: false,
          summary: `tap failed: ${bounded(tapped.output, 2000).text}`,
          mode,
          x,
          y,
          udid,
          ...(elementLine !== undefined ? { element: elementLine } : {}),
          notes,
        };
      }

      // Combined tap → capture: the question after a tap is what it did, so let
      // the animation settle and hand back the resulting screen in one call.
      let screenshotPath: string | undefined;
      let screenshotBytes: number | undefined;
      let screenshotImage: Record<string, unknown> | undefined;
      if (args.screenshot !== false) {
        const settleMs = Math.floor(positiveNumber(args.settle_ms, 700, 0, 10000));
        if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
        const captured = await captureScreen({
          cwd,
          udid,
          prefix: 'tap',
          attach: true,
          notes,
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        });
        if (captured.ok) {
          screenshotPath = captured.path;
          screenshotBytes = captured.bytes;
          screenshotImage = captured.image;
        } else {
          notes.push(`the tap succeeded but the post-tap screenshot failed: ${captured.failure}`);
        }
      }

      return {
        ok: true,
        summary:
          mode === 'accessibility'
            ? `tapped the element for ${JSON.stringify(accessibilityId)} at (${x}, ${y}) on ${udid}`
            : `tapped (${x}, ${y}) on ${udid}`,
        mode,
        x,
        y,
        ...(elementLine !== undefined ? { element: elementLine } : {}),
        ...(screenshotPath !== undefined ? { screenshotPath } : {}),
        ...(screenshotBytes !== undefined ? { bytes: screenshotBytes } : {}),
        ...(screenshotImage !== undefined ? { image: screenshotImage } : {}),
        udid,
        notes,
      };
    },
  });

  register({
    name: 'simulator_elements',
    description:
      'List the booted simulator\'s accessibility elements with their identifiers and centres, read from ' +
      '`idb ui describe-all`. Use it to discover what simulator_tap can target by `accessibility_id`, and ' +
      'to see where an element sits before tapping a raw coordinate.',
    isConcurrencySafe: () => true,
    timeoutMs: 180000,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on the element label or identifier.',
        },
        device: { type: 'string', description: 'Simulator name, UDID, or `booted`. Defaults to the booted device.' },
        max_elements: {
          type: 'number',
          description: 'How many matching elements to return. Defaults to 60, clamped to 1–400.',
        },
        cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary', 'notes'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          elements: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          udid: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render(
        _args: unknown,
        value: { summary: string; elements?: string; notes?: unknown },
      ): unknown[] {
        const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
        const parts = [
          value.summary,
          notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
          value.elements,
        ].filter(isNonEmptyString);
        return [textBlock(parts.join('\n\n'))];
      },
    },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
      const cwd = resolveCwd(config, args.cwd);
      const notes: string[] = [];

      const resolved = await resolveDevice(ctx, config, cwd, args.device);
      if (resolved.udid === undefined) {
        return {
          ok: false,
          summary: resolved.note ?? 'no booted simulator; boot one with simulator_control first',
          notes,
        };
      }
      const udid = resolved.udid;

      const described = await runIdb(['ui', 'describe-all', '--udid', udid], cwd, exec.signal, notes);
      if (described.unavailable) {
        return { ok: false, summary: described.output, udid, notes };
      }
      if (described.exitCode !== 0) {
        return {
          ok: false,
          summary: `could not read the accessibility tree: ${bounded(described.output, 2000).text}`,
          udid,
          notes,
        };
      }

      const all = parseAccessibilityElements(described.output);
      const query = isNonEmptyString(args.query) ? args.query.trim().toLowerCase() : undefined;
      const matching =
        query === undefined
          ? all
          : all.filter(
              (element) =>
                element.label.toLowerCase().includes(query) || element.uniqueId.toLowerCase().includes(query),
            );
      const limit = Math.floor(positiveNumber(args.max_elements, 60, 1, 400));
      const shown = matching.slice(0, limit);
      if (all.length === 0) {
        notes.push('the accessibility tree was empty; the screen may be showing a system UI or nothing focusable');
      } else if (shown.length < matching.length) {
        notes.push(`showing ${shown.length} of ${matching.length} matching elements`);
      }

      const rendered = shown.map(formatAccessibilityElement).join('\n');
      const boundedText = boundedTail(rendered, config.maxOutputChars);
      if (boundedText.truncated) {
        notes.push(`the list was trimmed to the last ${config.maxOutputChars} characters`);
      }

      return {
        ok: true,
        summary:
          `read ${all.length} element(s) from ${udid}` +
          (query !== undefined ? `, ${matching.length} matching ${JSON.stringify(args.query)}` : '') +
          `, returning ${shown.length}`,
        ...(boundedText.text.length > 0 ? { elements: boundedText.text } : {}),
        total: all.length,
        returned: shown.length,
        udid,
        notes,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Capability 3: SwiftUI guidance in the system prompt
  // ---------------------------------------------------------------------------

  if (config.injectSwiftUIGuidance) {
    // Place the guidance one slot after the deployment persona: it is a
    // project convention, so it precedes the per-tool sections (TOOL_BASH at
    // 1000) and follows the identity/persona text. `+1` only needs to keep a
    // stable relative position, never an absolute number.
    const order = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1;
    disposers.push(
      ctx.systemPrompt.section({
        name: 'ios-dev-helper/swiftui',
        order,
        // Drop the section entirely when this plugin's tools are hidden from the
        // viewing scope, so prompt and tool surface never disagree.
        text: ({ scope }) =>
          ctx.tools.get('xcode_build', scope) === undefined ? '' : SWIFTUI_GUIDANCE,
      }),
    );
  }

  // Cordis disposes effect-owned registrations on unload; returning the same
  // cleanup keeps teardown explicit and idempotent.
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // A registration already removed by scope teardown must not break unload.
      }
    }
  };
}
