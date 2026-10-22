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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { basename, dirname, isAbsolute, join } from 'node:path';
/** Services this plugin needs. The plugin stays inactive without them. */
export const inject = ['tools', 'subprocess', 'systemPrompt'];
const DEFAULT_CONFIG = {
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
/**
 * This plugin's own version, read from its `package.json` so the two can never drift.
 *
 * It is stamped into every tool description and into the guidance heading so "which
 * build is the running Host actually holding?" is answerable from the outside: a
 * plugin loaded from a cached module keeps serving its old schemas, and without a
 * stamp that is indistinguishable from a successful reload (learned the hard way —
 * a stale Host had to be identified by diffing a field description).
 */
function readPluginVersion() {
    try {
        const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(raw);
        const version = parsed !== null && typeof parsed === 'object'
            ? parsed.version
            : undefined;
        return isNonEmptyString(version) ? version.trim() : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/** The version marker appended to every tool description. */
const PLUGIN_VERSION = readPluginVersion();
const VERSION_STAMP = `[ios-dev-helper v${PLUGIN_VERSION}]`;
/** Consecutive \`xcode_build\` failures before the result starts recommending a cleanup. */
const CONSECUTIVE_BUILD_FAILURES = 3;
/** Payload of the SwiftUI/HIG system-prompt section owned by this plugin. */
const SWIFTUI_GUIDANCE = `## iOS development conventions (ios-dev-helper v${PLUGIN_VERSION})

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
function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}
/** Read a positive finite number from raw config, else the fallback. */
function positiveNumber(raw, fallback, low, high) {
    const value = typeof raw === 'number' ? raw : Number.NaN;
    return Number.isFinite(value) && value > 0 ? clamp(value, low, high) : fallback;
}
/** Resolve raw plugin config (from `cordis.patch.yml`) into a complete config. */
function resolveConfig(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    const text = (key, fallback) => {
        const value = source[key];
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
    };
    const flag = (key, fallback) => {
        const value = source[key];
        return typeof value === 'boolean' ? value : fallback;
    };
    const rawDerivedData = source.derivedDataPath;
    const derivedDataConfigured = typeof rawDerivedData === 'string' && rawDerivedData.trim().length > 0;
    return {
        workspaceRoot: text('workspaceRoot', DEFAULT_CONFIG.workspaceRoot),
        xcodebuildPath: text('xcodebuildPath', DEFAULT_CONFIG.xcodebuildPath),
        xcrunPath: text('xcrunPath', DEFAULT_CONFIG.xcrunPath),
        derivedDataPath: derivedDataConfigured ? rawDerivedData.trim() : DEFAULT_CONFIG.derivedDataPath,
        derivedDataPathConfigured: derivedDataConfigured,
        screenshotDir: text('screenshotDir', DEFAULT_CONFIG.screenshotDir),
        idbPath: text('idbPath', DEFAULT_CONFIG.idbPath),
        idbTimeoutMs: positiveNumber(source.idbTimeoutMs, DEFAULT_CONFIG.idbTimeoutMs, 1000, 30 * 60 * 1000),
        podPath: text('podPath', DEFAULT_CONFIG.podPath),
        swiftPath: text('swiftPath', DEFAULT_CONFIG.swiftPath),
        dependenciesTimeoutMs: positiveNumber(source.dependenciesTimeoutMs, DEFAULT_CONFIG.dependenciesTimeoutMs, 1000, 60 * 60 * 1000),
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
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
/**
 * Pick a usable message, falling back when the candidate is missing *or blank*.
 *
 * `candidate ?? fallback` is not enough: a helper such as `bounded('')` yields an
 * empty string, which `??` keeps, and the caller then reports a completely empty
 * error — the worst possible outcome for a failure the model must act on.
 * @param candidate Value to use when it is a non-empty string.
 * @param fallback Message returned when `candidate` is missing or blank.
 * @returns The chosen message, trimmed.
 */
function messageOr(candidate, fallback) {
    return isNonEmptyString(candidate) ? candidate.trim() : fallback;
}
/**
 * Clamp a string to at most `max` UTF-16 code units without splitting a
 * surrogate pair, keeping the head.
 *
 * `slice` counts code units, so an astral-plane character straddling the cut (an
 * emoji, a rare CJK extension-B ideograph such as 𠀀) is left as a lone
 * surrogate: it renders as U+FFFD and corrupts the text. Dropping the trailing
 * high surrogate keeps the result valid. BMP text — ordinary Chinese included —
 * is a single code unit per character and is unaffected either way.
 * @param text Text to clamp.
 * @param max Maximum number of UTF-16 code units to keep.
 * @returns The head of `text`, never ending on a lone high surrogate.
 */
function clampHead(text, max) {
    if (text.length <= max)
        return text;
    const cut = text.slice(0, max);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/**
 * Clamp a string to `max` code units, keeping the tail, without splitting a pair.
 * @param text Text to clamp.
 * @param max Maximum number of UTF-16 code units to keep.
 * @returns The tail of `text`, never starting on a lone low surrogate.
 */
function clampTail(text, max) {
    if (text.length <= max)
        return text;
    const cut = text.slice(text.length - max);
    return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}
/**
 * Trim trailing whitespace and cap a string at `max` characters, keeping the head.
 * @param text Text to clamp.
 * @param max Character budget for the kept head.
 * @returns The clamped head plus whether anything was dropped.
 */
function bounded(text, max) {
    const trimmed = text.trim();
    return trimmed.length <= max
        ? { text: trimmed, truncated: false }
        : { text: `${clampHead(trimmed, max)}\n… (${trimmed.length - max} more characters truncated)`, truncated: true };
}
/**
 * Keep the *end* of a string, capped at `max` characters.
 *
 * Build logs put their verdict last (`** BUILD SUCCEEDED **`, the error count,
 * the failing target), so the tail is the useful half of a long log.
 * @param text Text to clamp.
 * @param max Character budget for the kept tail.
 * @returns The clamped tail plus whether anything was dropped.
 */
function boundedTail(text, max) {
    const trimmed = text.trim();
    return trimmed.length <= max
        ? { text: trimmed, truncated: false }
        : { text: `… (${trimmed.length - max} earlier characters truncated)\n${clampTail(trimmed, max)}`, truncated: true };
}
/**
 * Run one managed child process to completion and collect its bounded output.
 * A nonzero exit code is a normal result; only infrastructure failures throw.
 * @param ctx Plugin context carrying the `subprocess` service.
 * @param config Resolved plugin configuration (budgets and signal grace).
 * @param options Command line, working directory, time budget, optional caller signal.
 * @returns Exit facts plus the combined, bounded output; an infrastructure failure comes back as `unavailable` rather than throwing.
 */
async function runCommand(ctx, config, options) {
    const subprocess = ctx.subprocess ?? ctx.get('subprocess');
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
    const onCallerAbort = () => controller.abort();
    if (caller !== undefined) {
        if (caller.aborted)
            controller.abort();
        else
            caller.addEventListener('abort', onCallerAbort, { once: true });
    }
    let timedOut = false;
    const collect = { maxBytes: config.maxOutputBytes };
    let clearTimer;
    let clearQuiescenceTimer;
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
        // Aborting starts the provider's own teardown (`graceMs` is its SIGTERM ->
        // SIGKILL grace), and `done` resolves on the *direct* process exit. A killed
        // build can therefore still have its managed range alive — the compiler
        // children `xcodebuild` spawned — so hold the tier on real quiescence before
        // reporting. The wait is bounded so the tool can never hang on it, and a
        // failure to prove quiescence is reported rather than swallowed.
        let quiescenceUnproven;
        // Quiescence is awaited whenever this call is why the child stopped — its own
        // budget expired, the host cancelled it, or something signalled it — not only on a
        // timeout. A cancelled build used to return as soon as the *direct* xcodebuild
        // process was gone, while the compiler children it had spawned could still be
        // running and holding the DerivedData build database.
        const callerCancelled = options.signal !== undefined && options.signal.aborted;
        if (timedOut || callerCancelled || outcome.exitCode === null) {
            if (outcome.exitCode === null)
                handle.terminate();
            if (typeof handle.waitForExit === 'function') {
                let deadlineTimer;
                const deadline = new Promise((resolve) => {
                    // Armed here, not inside the cleanup, so the bound is real: without it a
                    // provider that never reports quiescence would hang the tool forever.
                    deadlineTimer = setTimeout(() => resolve(false), config.graceMs + 2000);
                });
                clearQuiescenceTimer = () => {
                    if (deadlineTimer !== undefined)
                        clearTimeout(deadlineTimer);
                };
                const quiesced = await Promise.race([
                    handle.waitForExit().then(() => true, () => false),
                    deadline,
                ]);
                quiescenceUnproven = !quiesced;
            }
            else {
                quiescenceUnproven = true;
            }
        }
        const stdout = handle.collected.stdout?.readFrom(0);
        const stderr = handle.collected.stderr?.readFrom(0);
        const pieces = [];
        if (stdout !== undefined && stdout.text.length > 0)
            pieces.push(stdout.text);
        if (stderr !== undefined && stderr.text.length > 0) {
            pieces.push(pieces.length > 0 && !stdout.text.endsWith('\n') ? `\n[stderr]\n${stderr.text}` : `[stderr]\n${stderr.text}`);
        }
        return {
            output: pieces.join(''),
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            lossy: stdout?.lossy === true || stderr?.lossy === true,
            timedOut,
            ...(quiescenceUnproven !== undefined ? { quiescenceUnproven } : {}),
            unavailable: false,
        };
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            output: `failed to run \`${options.argv.join(' ')}\`: ${detail}`,
            exitCode: null,
            signal: null,
            lossy: false,
            timedOut: false,
            unavailable: true,
        };
    }
    finally {
        clearTimer?.();
        clearQuiescenceTimer?.();
        caller?.removeEventListener('abort', onCallerAbort);
    }
}
/**
 * True when the budget's own signal is what ended the child.
 *
 * `timedOut` only records that the timer fired; saying "terminated" when the child
 * actually ended by itself is a false statement that sends the caller chasing a
 * timeout which killed nothing.
 */
function stoppedByBudget(result) {
    return result.timedOut && result.signal !== null;
}
/**
 * True when the budget expired but the child had already finished on its own, so
 * nothing was killed and `exitCode` is its real verdict (0 means the work
 * succeeded and must not be reported as a failure).
 */
function outlivedBudget(result) {
    return result.timedOut && result.signal === null && result.exitCode !== null;
}
// Xcode diagnostics look like:
//   /abs/path/File.swift:12:5: error: cannot find 'foo' in scope
//   /abs/path/File.swift:12: error: ...
//   <unknown>:0: error: ...            (no usable path)
// Case-insensitive on purpose: the compilers write lowercase `error:`/`warning:`,
// but `xcodebuild` writes its own diagnostics in uppercase
// (`--- xcodebuild: WARNING: Using the first of multiple matching destinations:`).
// Case-sensitive matching dropped those, so a run xcodebuild had warned about was
// reported as "0 warning(s)" — and with `treatWarningsAsErrors` it passed as clean.
const DIAGNOSTIC_PATTERN = /^(.*?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.*)$/i;
// `xcodebuild` also reports failures that carry no file/line at all, and those
// are exactly the ones a caller most needs (a missing scheme, an unmatched
// destination). Without these fallbacks a failed build reported "0 errors".
//   xcodebuild: error: The project named "X" does not contain a scheme named "Y"
//   error: something went wrong
// `-{2,}\s*` absorbs the decoration xcodebuild puts before its own name, so the
// producer is reported as `xcodebuild` rather than `--- xcodebuild`.
const TOOL_DIAGNOSTIC_PATTERN = /^(?:-{2,}\s*)?([^\s:][^:]*?):\s*(error|warning):\s*(.*)$/i;
const BARE_DIAGNOSTIC_PATTERN = /^(error|warning):\s*(.*)$/i;
const TARGET_HEADER_PATTERN = /^===\s*(.+?)\s*===$/;
/**
 * Parse compiler diagnostics from `xcodebuild` output.
 *
 * Only `error` and `warning` become bullets: `note` lines are informational
 * (input encodings, dependency-order chatter) and on a clean build they used to
 * bury the verdict under a dozen irrelevant lines.
 *
 * `limit` caps the *bullets*, not the counting: the scan always walks the whole
 * output, so `omitted` reports how many further error/warning lines were left out
 * instead of silently breaking. Stopping at the cap used to also undercount the
 * summary — a build with 100 errors was reported as "40 error(s)".
 * @param output Combined stdout/stderr of one `xcodebuild` run.
 * @param limit Maximum number of bullets to keep; the scan and counting are unaffected.
 * @returns The kept `items` plus per-severity `omitted` counts.
 */
function parseDiagnostics(output, limit) {
    const found = [];
    const omitted = { error: 0, warning: 0 };
    for (const line of output.split(/\r?\n/)) {
        if (TARGET_HEADER_PATTERN.test(line))
            continue;
        let file = '';
        let lineNumber;
        let column;
        let severity = '';
        let message = '';
        const located = DIAGNOSTIC_PATTERN.exec(line);
        if (located !== null) {
            const [, locatedFile, locatedLine, locatedColumn, locatedSeverity, locatedMessage] = located;
            file = locatedFile.trim();
            lineNumber = Number(locatedLine);
            column = locatedColumn !== undefined ? Number(locatedColumn) : undefined;
            severity = locatedSeverity.toLowerCase();
            message = locatedMessage;
        }
        else {
            const bare = BARE_DIAGNOSTIC_PATTERN.exec(line);
            const tool = bare === null ? TOOL_DIAGNOSTIC_PATTERN.exec(line) : null;
            const match = bare ?? tool;
            if (match === null)
                continue;
            // For `xcodebuild: error: ...` the leading token names the producer.
            file = bare !== null ? 'xcodebuild' : (match[1] ?? 'xcodebuild').trim();
            severity = (match[bare !== null ? 1 : 2] ?? '').toLowerCase();
            message = match[bare !== null ? 2 : 3] ?? '';
        }
        if (severity === 'note')
            continue;
        // This project whitelists SwiftPM/sandbox cache noise in
        // `Tools/run_tests.sh` (`CHANNEL_FORBID_ALLOW`), where it is applied to
        // *warning* lines only. Applying it to every severity here silently swallowed
        // genuine errors: "… is not writable" is precisely how a permission failure
        // reads, and dropping it left the caller with "0 error(s)".
        if (severity === 'warning' && /swiftpm|not writable|readonly database/i.test(message))
            continue;
        if (found.length >= limit) {
            // Past the bullet budget: keep counting so the summary stays truthful and
            // the caller learns the list was cut.
            if (severity === 'error')
                omitted.error += 1;
            else
                omitted.warning += 1;
            continue;
        }
        found.push({
            file: file.length === 0 ? 'xcodebuild' : file,
            ...(lineNumber !== undefined ? { line: lineNumber } : {}),
            ...(column !== undefined ? { column } : {}),
            severity,
            message: message.trim(),
        });
    }
    return { items: found, omitted };
}
/**
 * Failure signatures `xcodebuild` emits when it cannot write where it needs to.
 *
 * These arrive as opaque `NSPOSIXErrorDomain … Operation not permitted` or
 * `… is not writable` lines that name no cause, so they are worth translating into
 * something the caller can act on.
 */
const WRITE_BLOCKED_PATTERN = /Operation not permitted|Permission denied|Read-only file system|not writable|readonly database/i;
/**
 * Describe a write-permission failure found in build output, or `undefined` when
 * the output shows none.
 *
 * @param output Combined stdout/stderr of one `xcodebuild` run.
 * @returns A one-clause cause naming what to check, or `undefined`.
 */
function describeWriteBlockedCause(output) {
    const match = WRITE_BLOCKED_PATTERN.exec(output);
    if (match === null)
        return undefined;
    return (`a write-permission failure (matched "${match[0]}"): check that the project directory and the ` +
        'DerivedData path are writable, and that this process is allowed to write there — a confined ' +
        'shell cannot write under ~/Library/Developer');
}
/**
 * Render diagnostics as compact single lines, deduplicated in order.
 *
 * @param diagnostics Parsed diagnostics, already capped by `maxDiagnostics`.
 * @returns Newline-joined `- <where>: <severity>: <message>` bullets.
 */
function formatDiagnostics(diagnostics) {
    const seen = new Set();
    const lines = [];
    for (const item of diagnostics) {
        // A tool-level diagnostic has no position; print just the producer name
        // rather than a misleading `:0`.
        const where = item.line !== undefined
            ? `${item.file}:${item.line}${item.column !== undefined ? `:${item.column}` : ''}`
            : item.file;
        const line = `- ${where}: ${item.severity}: ${item.message}`;
        if (seen.has(line))
            continue;
        seen.add(line);
        lines.push(line);
    }
    return lines.join('\n');
}
/**
 * Assemble the `xcodebuild` argument vector for one call.
 *
 * Deliberately pure: it spawns nothing, reads no filesystem and mutates no state, so
 * the exact command a call will run — and the notes explaining it — can be asserted
 * directly in tests. Everything side-effecting (project discovery, the target
 * preflight, the optional `simctl shutdown all`) stays with the caller.
 *
 * @param input Resolved `action`, `target` and `scheme`, the raw `args` for the
 *   remaining switches, the plugin config and the working directory.
 * @returns `{ argv, notes, destination, derivedDataPath }` on success, or
 *   `{ error }` when an argument is malformed (`onlyTesting`).
 */
export function buildXcodeInvocation(input) {
    const { args, config, cwd, action, target, scheme } = input;
    const notes = [];
    const flag = target.endsWith('.xcworkspace') ? '-workspace' : '-project';
    // Only an explicit request is forwarded: passing a default would override a
    // scheme's own build configuration, which is not this tool's decision.
    const configuration = isNonEmptyString(args.configuration) ? args.configuration.trim() : undefined;
    // `onlyTesting` constrains a test action to specific identifiers. The earlier
    // `only_testing` spelling stays accepted so an existing caller does not break, but
    // the camelCase name is the documented one.
    const rawOnlyTesting = args.onlyTesting ?? args.only_testing;
    let onlyTesting = [];
    if (rawOnlyTesting !== undefined) {
        if (!Array.isArray(rawOnlyTesting)) {
            return {
                error: '`onlyTesting` must be an array of test identifiers, e.g. ["LunisolarCalendarUITests"]',
            };
        }
        const malformed = rawOnlyTesting.filter((entry) => !isNonEmptyString(entry)).length;
        if (malformed > 0) {
            return {
                error: `every \`onlyTesting\` entry must be a non-empty string; ` +
                    `${malformed} entr${malformed === 1 ? 'y is' : 'ies are'} not`,
            };
        }
        onlyTesting = [...new Set(rawOnlyTesting.map((entry) => entry.trim()))];
        if (onlyTesting.length === 0) {
            return { error: '`onlyTesting` was empty; list at least one test identifier, or omit the argument' };
        }
    }
    const argv = [config.xcodebuildPath, action, flag, target];
    if (scheme !== undefined)
        argv.push('-scheme', scheme);
    if (configuration !== undefined)
        argv.push('-configuration', configuration);
    const callerRequestedSimulator = isNonEmptyString(args.simulator);
    let destination = isNonEmptyString(args.destination) ? args.destination.trim() : undefined;
    // A destination is *composed* only for actions that need one, but a destination the
    // caller asked for (or a named simulator) is honoured for every action. Omitting it
    // makes xcodebuild guess — it says so itself:
    //   "--- xcodebuild: WARNING: Using the first of multiple matching destinations:"
    // — and for `clean` a wrong guess can clean another destination's products.
    const needsDestination = action !== 'clean' && action !== 'build-for-testing'
        ? true
        : destination !== undefined || callerRequestedSimulator;
    if (destination === undefined && needsDestination) {
        const simulator = isNonEmptyString(args.simulator) ? args.simulator.trim() : undefined;
        const os = isNonEmptyString(args.os) ? args.os.trim() : undefined;
        if (simulator !== undefined) {
            if (UDID_PATTERN.test(simulator)) {
                // A UDID is unambiguous and survives a rename, so it is passed as `id=`.
                destination = `platform=iOS Simulator,id=${simulator}`;
            }
            else {
                // A name stays exactly a name. `iPhone Duo` must reach xcodebuild as
                // `platform=iOS Simulator,name=iPhone Duo` — the device's `simctl` name — and must
                // not be rewritten into its device-type identifier
                // (`…SimDeviceType.iPhone-Duo`), which xcodebuild cannot match to a destination.
                destination =
                    os !== undefined
                        ? `platform=iOS Simulator,name=${simulator},OS=${os}`
                        : `platform=iOS Simulator,name=${simulator}`;
            }
        }
    }
    if (destination !== undefined)
        argv.push('-destination', destination);
    // `xcodebuild` accepts both `-only-testing <id>` and `-only-testing:<id>`; the joined
    // form is the one this repository's Tools/run_tests.sh uses.
    for (const identifier of onlyTesting)
        argv.push(`-only-testing:${identifier}`);
    if (onlyTesting.length > 0 && !TEST_ACTIONS.has(action)) {
        notes.push(`\`onlyTesting\` only constrains test actions; the \`${action}\` action ignores it`);
    }
    // DerivedData decides whether repeat builds are incremental. Precedence: the
    // per-call argument, then the configured path, then the built-in default — and the
    // result is applied unconditionally. Gating the default on the directory already
    // existing (the earlier behaviour) made it unreachable: nothing else creates
    // `<cwd>/.dsh/DerivedData`, so the default could never bootstrap itself and every
    // build kept writing to the shared ~/Library DerivedData. The price of applying it
    // is one full rebuild the first time a workspace switches location; `xcodebuild`
    // creates the directory itself.
    //
    // The path is a single argv element: no shell parses this command, so quoting it
    // (`-derivedDataPath "<path>"`) would literally embed quotes in the path.
    const requestedDerivedData = isNonEmptyString(args.derived_data_path)
        ? args.derived_data_path.trim()
        : config.derivedDataPath;
    const derivedDataIsExplicit = isNonEmptyString(args.derived_data_path) || config.derivedDataPathConfigured;
    const derivedDataPath = requestedDerivedData.length === 0
        ? undefined
        : isAbsolute(requestedDerivedData)
            ? requestedDerivedData
            : join(cwd, requestedDerivedData);
    if (derivedDataPath !== undefined) {
        notes.push(derivedDataIsExplicit
            ? `using the configured DerivedData path: ${derivedDataPath}`
            : `using the workspace DerivedData path (default) for incremental builds: ${derivedDataPath}`);
        argv.push('-derivedDataPath', derivedDataPath);
    }
    if (Array.isArray(args.extra_args)) {
        for (const entry of args.extra_args) {
            if (isNonEmptyString(entry))
                argv.push(entry);
        }
    }
    return { argv, notes, destination, derivedDataPath };
}
async function discoverProject(ctx, config, cwd, signal) {
    // Discovery is about files in `cwd`. It used to begin with a
    // `xcrun simctl list devices available` call whose result was never read except
    // for an `unavailable` guard — a wasted spawn on every build, and a misleading
    // early exit: with `xcrun` unusable (Xcode not selected) discovery reported
    // "no project found" for a project sitting right there.
    const probe = await runCommand(ctx, config, {
        argv: ['/bin/sh', '-c', 'ls -1d *.xcworkspace *.xcodeproj 2>/dev/null'],
        cwd,
        timeoutMs: 15000,
        ...(signal !== undefined ? { signal } : {}),
    });
    if (probe.unavailable)
        return { schemes: [], diagnostics: '', detectionLog: probe.output };
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
        ...(signal !== undefined ? { signal } : {}),
    });
    let schemes = [];
    let diagnostics = '';
    const record = parseJsonObject(listed.output);
    if (record !== undefined) {
        const fromJson = record.schemes;
        if (Array.isArray(fromJson))
            schemes = fromJson.filter(isNonEmptyString);
        const project = record.project;
        if (schemes.length === 0 && project !== undefined && Array.isArray(project.schemes)) {
            schemes = project.schemes.filter(isNonEmptyString);
        }
        diagnostics = isNonEmptyString(record.error) ? record.error : '';
    }
    if (schemes.length === 0) {
        // `-json` is unavailable on old toolchains, and a project can legitimately
        // report no schemes: fall back to the human-readable list output.
        schemes = schemesFromText(listed.output);
        if (schemes.length === 0 && listed.exitCode !== 0)
            diagnostics = listed.output;
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
 * @param output Text that may contain a JSON object.
 * @returns The first balanced `{…}` slice, or undefined when there is none.
 */
function extractJsonObject(output) {
    for (let start = output.indexOf('{'); start >= 0; start = output.indexOf('{', start + 1)) {
        let lookahead = start + 1;
        while (lookahead < output.length && /\s/.test(output[lookahead]))
            lookahead += 1;
        const next = output[lookahead];
        if (next !== '"' && next !== '}')
            continue;
        const candidate = scanBalancedObject(output, start);
        if (candidate !== undefined)
            return candidate;
    }
    return undefined;
}
/**
 * Scan a balanced brace region starting at `start`, honouring string literals.
 * @param output Text to scan.
 * @param start Index of the opening `{`.
 * @returns The balanced object slice, or undefined when it never closes.
 */
function scanBalancedObject(output, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
        const character = output[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                inString = false;
            continue;
        }
        if (character === '"')
            inString = true;
        else if (character === '{')
            depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0)
                return output.slice(start, index + 1);
        }
    }
    return undefined;
}
/**
 * Parse a JSON document out of tool output, tolerating extractor or toolchain
 * surprises. A malformed document yields `undefined` so the caller can fall
 * back to a text form instead of failing the whole tool call.
 * @param output Text that may contain a JSON object.
 * @returns The parsed object, or undefined when it is absent or malformed.
 */
function parseJsonObject(output) {
    const candidate = extractJsonObject(output);
    if (candidate === undefined)
        return undefined;
    try {
        const parsed = JSON.parse(candidate);
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Extract the scheme list from the human-readable `xcodebuild -list` output.
 * @param output Human-readable `xcodebuild -list` text.
 * @returns Scheme names in the order they were encountered.
 */
function schemesFromText(output) {
    const match = /Schemes:\s*\n([\s\S]*?)(?:\n\s*\n|$)/.exec(output);
    if (match === null)
        return [];
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
 * @param schemes Scheme names reported by `xcodebuild -list`.
 * @param target Project or workspace file name.
 * @returns The scheme whose name matches the target stem, or undefined when none does.
 */
function preferredScheme(schemes, target) {
    const base = target.replace(/\.(xcodeproj|xcworkspace)$/i, '');
    if (base.length === 0)
        return undefined;
    const lower = base.toLowerCase();
    return (schemes.find((scheme) => scheme === base) ??
        schemes.find((scheme) => scheme.toLowerCase() === lower) ??
        schemes.find((scheme) => scheme.toLowerCase().startsWith(lower)));
}
/**
 * Resolve the working directory for a tool call.
 * @param config Resolved plugin configuration (supplies `workspaceRoot`).
 * @param requested Per-call `cwd` override, when present.
 * @returns The absolute working directory to run a command in.
 */
function resolveCwd(config, requested) {
    if (isNonEmptyString(requested))
        return requested;
    if (config.workspaceRoot.length > 0)
        return config.workspaceRoot;
    return process.cwd();
}
/**
 * Read the runtime-grouped device map from a `simctl ... -j` document.
 * @param document Parsed `simctl list … -j` document.
 * @returns The `devices` map, or an empty object when it is absent.
 */
function deviceGroups(document) {
    const devices = document.devices;
    return devices !== null && typeof devices === 'object' ? devices : {};
}
/**
 * Render a `simctl list devices -j` document into compact text.
 * @param document Parsed `simctl list devices -j` document.
 * @param runtimeFilter Optional case-insensitive runtime substring to keep.
 * @returns A compact multi-line listing, or `no matching simulators`.
 */
function formatDevices(document, runtimeFilter) {
    const lines = [];
    for (const [runtime, devices] of Object.entries(deviceGroups(document))) {
        if (runtimeFilter !== undefined && !runtime.toLowerCase().includes(runtimeFilter.toLowerCase()))
            continue;
        lines.push(`## ${runtime.replace('com.apple.CoreSimulator.SimRuntime.', '')}`);
        for (const device of devices) {
            if (device.isAvailable === false)
                continue;
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
 * @param ctx Plugin context carrying the `subprocess` service.
 * @param config Resolved plugin configuration.
 * @param cwd Directory to run the query in.
 * @returns Names of currently booted simulators (empty when none, or when the list is unreadable).
 */
async function bootedSimulatorNames(ctx, config, cwd, signal) {
    const listed = await runCommand(ctx, config, {
        argv: [config.xcrunPath, 'simctl', 'list', 'devices', 'booted', '-j'],
        cwd,
        timeoutMs: config.simctlTimeoutMs,
        ...(signal !== undefined ? { signal } : {}),
    });
    const document = parseJsonObject(listed.output);
    if (document === undefined)
        return [];
    return Object.values(deviceGroups(document))
        .flat()
        .map((device) => String(device.name ?? device.udid ?? ''))
        .filter(isNonEmptyString);
}
/**
 * Resolve a simulator selector (UDID, `booted`, or a device name) to a UDID.
 * @param ctx Plugin context carrying the `subprocess` service.
 * @param config Resolved plugin configuration.
 * @param cwd Directory to run the lookup in.
 * @param requested UDID, device name, `booted`, or undefined to mean the booted device.
 * @returns The resolved UDID, or a `note` saying why none could be resolved.
 */
async function resolveDevice(ctx, config, cwd, requested, signal) {
    if (!isNonEmptyString(requested)) {
        const booted = await runCommand(ctx, config, {
            argv: [config.xcrunPath, 'simctl', 'list', 'devices', 'booted', '-j'],
            cwd,
            timeoutMs: config.simctlTimeoutMs,
            ...(signal !== undefined ? { signal } : {}),
        });
        const document = parseJsonObject(booted.output);
        if (document === undefined) {
            return { note: messageOr(bounded(booted.output, 2000).text, 'could not read the booted-device list from `xcrun simctl`') };
        }
        const devices = Object.values(deviceGroups(document)).flat();
        const first = devices[0];
        if (first === undefined)
            return { note: 'no booted simulator; boot one with simulator_control first' };
        return { udid: String(first.udid) };
    }
    const selector = requested.trim();
    if (UDID_PATTERN.test(selector)) {
        // A well-formed UDID is not proof that the device exists: a typo would sail
        // through to simctl and come back as a bare "Invalid device or device pair",
        // naming no alternative. Verify against the *full* device list (unavailable
        // devices included, because `erase`/`delete` may legitimately target one), and
        // pass the selector through only when that list cannot be read at all.
        const known = await runCommand(ctx, config, {
            argv: [config.xcrunPath, 'simctl', 'list', 'devices', '-j'],
            cwd,
            timeoutMs: config.simctlTimeoutMs,
            ...(signal !== undefined ? { signal } : {}),
        });
        const document = parseJsonObject(known.output);
        if (document === undefined)
            return { udid: selector };
        const exists = Object.values(deviceGroups(document))
            .flat()
            .some((device) => String(device.udid ?? '').toLowerCase() === selector.toLowerCase());
        return exists
            ? { udid: selector }
            : {
                note: `no simulator has the UDID \`${selector}\`; call action "list" to see the available ` +
                    'devices, or pass a device name instead',
            };
    }
    if (selector === 'booted')
        return resolveDevice(ctx, config, cwd, undefined, signal);
    const listed = await runCommand(ctx, config, {
        argv: [config.xcrunPath, 'simctl', 'list', 'devices', 'available', '-j'],
        cwd,
        timeoutMs: config.simctlTimeoutMs,
        ...(signal !== undefined ? { signal } : {}),
    });
    const document = parseJsonObject(listed.output);
    if (document === undefined) {
        return { note: messageOr(bounded(listed.output, 2000).text, 'could not read the device list from `xcrun simctl`') };
    }
    const matches = [];
    const typeMatches = [];
    for (const devices of Object.values(deviceGroups(document))) {
        for (const device of devices) {
            if (device.isAvailable === false)
                continue;
            const name = String(device.name ?? '');
            if (name === selector)
                matches.push(device);
            else if (matches.length === 0 && name.toLowerCase() === selector.toLowerCase())
                matches.push(device);
            // `simctl list devices -j` carries `deviceTypeIdentifier`, so a device *type* is
            // addressable too — which is how a foldable is reached when its instance name
            // (`iPhone Duo`) differs from its type (`iPhone-Duo`). Both the full identifier
            // and its last segment are accepted, case-insensitively.
            const typeIdentifier = String(device.deviceTypeIdentifier ?? '');
            const shortType = typeIdentifier.startsWith('com.apple.CoreSimulator.SimDeviceType.')
                ? typeIdentifier.slice('com.apple.CoreSimulator.SimDeviceType.'.length)
                : typeIdentifier;
            const wanted = selector.toLowerCase();
            if (typeIdentifier.length > 0 &&
                (typeIdentifier.toLowerCase() === wanted || shortType.toLowerCase() === wanted)) {
                typeMatches.push(device);
            }
        }
    }
    // Prefer an already-booted match so repeated calls target the same device.
    const booted = matches.find((device) => String(device.state) === 'Booted') ??
        matches[0] ??
        typeMatches.find((device) => String(device.state) === 'Booted') ??
        typeMatches[0];
    if (booted === undefined) {
        return {
            note: `no available simulator matches \`${selector}\` — neither a device name nor a device ` +
                'type (e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-Duo` or `iPhone-Duo`); ' +
                'call action "list" to see what exists',
        };
    }
    return { udid: String(booted.udid) };
}
/**
 * Resolve the optional `attachments` Service, or undefined when unavailable.
 * @param ctx Plugin context.
 * @returns The optional `attachments` service, or undefined when it is not mounted.
 */
function attachmentsOf(ctx) {
    const service = ctx.get('attachments');
    if (service === null || typeof service !== 'object')
        return undefined;
    return typeof service.saveImage === 'function'
        ? service
        : undefined;
}
/**
 * Describe a caught value, keeping any stable service error code.
 * @param error Any thrown value.
 * @returns Its message, or a stringified form when it is not an `Error`.
 */
function describeError(error) {
    if (error instanceof Error) {
        const code = error.code;
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
const TEST_ACTIONS = new Set(['test', 'test-without-building', 'build-for-testing']);
/**
 * CoreSimulator UDIDs are UUIDs in the canonical 8-4-4-4-12 form.
 *
 * The previous shape check (`^[0-9A-Fa-f-]{36}$`) also accepted things that are
 * plainly not UDIDs — 36 hyphens, for instance — and then handed them to simctl.
 */
const UDID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/**
 * CoreSimulator infrastructure flake, as this repository itself defines it.
 *
 * Mirrors `FLAKY_INFRA_PATTERN` in `Tools/run_tests.sh:50` — the project's own line
 * between "the simulator infrastructure hiccuped, retry once" and "a real failure,
 * never retry". Reusing the same signals keeps the two definitions from drifting.
 */
const FLAKY_SIMCTL_PATTERN = /Failed to install or launch the test runner|failed preflight checks|SBMainWorkspace.*Busy|Unable to boot device|Timed out while loading|database is locked|device is busy/i;
/**
 * `simctl` verbs `simulator_control` exposes.
 *
 * A typo must be rejected *before* spawning anything: `xcrun simctl shutown <udid>`
 * otherwise answers with its entire usage text, which tells the caller nothing
 * about which argument was actually wrong.
 */
const SIMULATOR_ACTIONS = new Set([
    'list',
    'boot',
    'shutdown',
    'booted',
    'open',
    'erase',
    'delete',
    'runtime_list',
]);
/**
 * `xcodebuild` actions that actually *run* tests rather than only preparing them.
 * These are the actions a booted simulator can interfere with, and the only ones
 * where "zero tests executed" is a meaningful signal.
 */
const RUNS_TESTS = new Set(['test', 'test-without-building']);
/**
 * Reduce `log stream --style=ndjson` output to its newest Error/Fault entries.
 *
 * Non-JSON lines are skipped on purpose: `log` prints a banner naming the
 * resolved predicate, and the merged stderr contributes lines too.
 * @param output Newline-delimited `log stream --style=ndjson` output.
 * @param limit Maximum number of entries to return (the newest are kept).
 * @returns The newest `entries` and how many matching records were seen.
 */
function parseLogEntries(output, limit) {
    const matched = [];
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed[0] !== '{')
            continue;
        let record;
        try {
            record = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const level = typeof record.messageType === 'string' ? record.messageType : '';
        if (!/^(error|fault)$/i.test(level))
            continue;
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
            message: message.length <= MAX_LOG_MESSAGE_CHARS
                ? message
                : `${clampHead(message, MAX_LOG_MESSAGE_CHARS)}… (${message.length - MAX_LOG_MESSAGE_CHARS} more chars)`,
        });
    }
    // The newest entries are the interesting ones, so keep the tail.
    return { entries: matched.slice(-limit), matched: matched.length };
}
/**
 * Render one log entry as a single compact line.
 * @param entry One parsed log record.
 * @returns A single compact line.
 */
function formatLogEntry(entry) {
    const scope = entry.scope.length > 0 ? ` [${entry.scope}]` : '';
    return `${entry.time} ${entry.level.toUpperCase()} ${entry.process}${scope}: ${entry.message}`;
}
/**
 * Expand a leading `~` to the home directory.
 *
 * `spawn` performs no shell expansion, so a configured `~/...` path would be
 * passed literally and fail to resolve.
 * @param value A path that may start with `~` or `~/`.
 * @returns The expanded path, unchanged when it has no leading `~`.
 */
function expandHome(value) {
    if (value === '~')
        return homedir();
    return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}
/**
 * Centre of an element, the point a tap should hit.
 * @param element Accessibility element carrying a frame.
 * @returns The rounded centre point a tap should target.
 */
function elementCentre(element) {
    return {
        x: Math.round(element.x + element.width / 2),
        y: Math.round(element.y + element.height / 2),
    };
}
/**
 * Read a finite number from an unknown JSON field.
 * @param value Candidate JSON value.
 * @returns The value when it is a finite number, otherwise undefined.
 */
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/**
 * Reduce `idb ui describe-all` JSON to the elements worth reporting.
 *
 * The payload is a flat array of accessibility nodes; `frame` is normally
 * present, but `AXFrame` (`"{{x, y}, {w, h}}"`) is kept as a fallback so a
 * format change degrades to missing elements rather than a thrown parse error.
 * @param output Raw `idb ui describe-all` output (any text containing the JSON array).
 * @returns Tappable elements with a positive frame; unparsable input yields an empty array.
 */
function parseAccessibilityElements(output) {
    const start = output.indexOf('[');
    if (start < 0)
        return [];
    let records;
    try {
        records = JSON.parse(output.slice(start));
    }
    catch {
        return [];
    }
    if (!Array.isArray(records))
        return [];
    const elements = [];
    for (const record of records) {
        if (record === null || typeof record !== 'object')
            continue;
        const node = record;
        let x;
        let y;
        let width;
        let height;
        const frame = node.frame;
        if (frame !== null && typeof frame === 'object') {
            const f = frame;
            x = numberOf(f.x);
            y = numberOf(f.y);
            width = numberOf(f.width);
            height = numberOf(f.height);
        }
        if (x === undefined || y === undefined || width === undefined || height === undefined) {
            const axFrame = typeof node.AXFrame === 'string' ? node.AXFrame : '';
            const parsed = /\{\{([-\d.]+),\s*([-\d.]+)\},\s*\{([-\d.]+),\s*([-\d.]+)\}\}/.exec(axFrame);
            if (parsed === null)
                continue;
            x = Number(parsed[1]);
            y = Number(parsed[2]);
            width = Number(parsed[3]);
            height = Number(parsed[4]);
        }
        if (width <= 0 || height <= 0)
            continue;
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
/**
 * Render one element as a compact, tappable line.
 * @param element Element with a frame.
 * @returns A compact `Type "label" id="…" @ (x, y)` line.
 */
function formatAccessibilityElement(element) {
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
 * @param elements Elements to search, as returned by `parseAccessibilityElements`.
 * @param wanted Accessibility identifier or label supplied by the caller.
 * @returns The best match (smallest frame among otherwise equal candidates), or undefined.
 */
function findAccessibilityElement(elements, wanted) {
    const target = wanted.trim();
    if (target.length === 0)
        return undefined;
    const lower = target.toLowerCase();
    const tappable = elements.filter((element) => element.type !== 'Application');
    const tiers = [
        (element) => element.uniqueId === target,
        (element) => element.label === target,
        (element) => element.uniqueId.toLowerCase() === lower || element.label.toLowerCase() === lower,
        (element) => element.uniqueId.toLowerCase().includes(lower) || element.label.toLowerCase().includes(lower),
    ];
    for (const matches of tiers) {
        const candidates = tappable.filter(matches);
        if (candidates.length === 0)
            continue;
        return candidates.reduce((best, element) => element.width * element.height < best.width * best.height ? element : best);
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
 * @param output Combined `xcodebuild test` output.
 * @returns The largest `Executed N test(s)` count seen, or undefined when the line never appeared.
 */
function countExecutedTests(output) {
    let max;
    for (const match of output.matchAll(/Executed (\d+) tests?[,.]/g)) {
        const count = Number(match[1]);
        max = max === undefined ? count : Math.max(max, count);
    }
    return max;
}
/**
 * A `ContentBlock`-shaped text block.
 * @param text Text to wrap.
 * @returns A `text` content block.
 */
function textBlock(text) {
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
};
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
 * @returns How many stale records were removed (0 when the registry is absent or unreadable).
 */
function pruneUnreachableIdbCompanions() {
    try {
        const raw = readFileSync(IDB_STATE_FILE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return 0;
        const reachable = parsed.filter((entry) => entry !== null &&
            typeof entry === 'object' &&
            typeof entry.path === 'string' &&
            existsSync(entry.path));
        const removed = parsed.length - reachable.length;
        if (removed > 0)
            writeFileSync(IDB_STATE_FILE_PATH, JSON.stringify(reachable));
        return removed;
    }
    catch {
        return 0;
    }
}
/**
 * A filesystem-safe, sortable timestamp for generated filenames, e.g.
 * `2026-10-03T21-35-04-123Z`. Millisecond precision keeps two captures in the
 * same second from overwriting each other.
 * @returns A filesystem-safe UTC timestamp for the current time.
 */
function fileTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}
/**
 * Parse the `Connected Screens` block of `simctl io <device> enumerate`.
 *
 * The block is a run of `Key: value` lines grouped as `Screen ID`, `Name`,
 * `Device Name`, `Screen Type`, with unrelated headers such as `(1) LCD:` between the
 * groups — so the grouping is driven by the `Screen ID` key, not by line position.
 *
 * @param output Raw `enumerate` output.
 * @returns Every screen it described, in output order.
 */
function parseEnumeratedScreens(output) {
    const screens = [];
    let idText;
    let name;
    let deviceName;
    let screenType;
    const flush = () => {
        if (name !== undefined && name.length > 0) {
            screens.push({
                ...(idText !== undefined && Number.isFinite(Number(idText)) ? { id: Number(idText) } : {}),
                name,
                ...(deviceName !== undefined ? { deviceName } : {}),
                ...(screenType !== undefined ? { screenType } : {}),
            });
        }
        idText = undefined;
        name = undefined;
        deviceName = undefined;
        screenType = undefined;
    };
    for (const raw of output.split(/\r?\n/)) {
        const match = /^(Screen ID|Device Name|Screen Type|Name):\s*(.+)$/.exec(raw.trim());
        if (match === null)
            continue;
        const key = match[1] ?? '';
        const value = (match[2] ?? '').trim();
        if (key === 'Screen ID') {
            if (name !== undefined)
                flush();
            idText = value;
        }
        else if (key === 'Name') {
            name = value;
        }
        else if (key === 'Device Name') {
            deviceName = value;
        }
        else {
            screenType = value;
        }
    }
    flush();
    return screens;
}
/**
 * Mean "how much of this frame is lit" for a PNG, read from its pixels.
 *
 * A fully black 2007x2853 simulator frame still compresses to ~106 KB, so file size says
 * nothing about content — a folded-away panel was being reported as rendering because its
 * PNG was large. This decodes the image (built-in `zlib`, no dependency), unfilters the
 * scanlines and samples every 8th pixel, which is enough to separate a blank panel from a
 * real one and cheap enough to run twice per call.
 *
 * @param path PNG file to measure.
 * @returns Dimensions plus the sampled fraction of non-black pixels, or `undefined` when
 *   the file is not a PNG this can read (16-bit, palette, interlaced).
 */
function pngStats(path) {
    try {
        const buffer = readFileSync(path);
        if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47)
            return undefined;
        let offset = 8;
        let width = 0;
        let height = 0;
        let bitDepth = 0;
        let colorType = 0;
        let interlace = 0;
        const compressed = [];
        while (offset + 8 <= buffer.length) {
            const length = buffer.readUInt32BE(offset);
            const type = buffer.toString('latin1', offset + 4, offset + 8);
            const start = offset + 8;
            const data = buffer.subarray(start, Math.min(start + length, buffer.length));
            if (type === 'IHDR') {
                width = data.readUInt32BE(0);
                height = data.readUInt32BE(4);
                bitDepth = data[8] ?? 0;
                colorType = data[9] ?? 0;
                interlace = data[12] ?? 0;
            }
            else if (type === 'IDAT') {
                compressed.push(data);
            }
            else if (type === 'IEND') {
                break;
            }
            offset = start + length + 4;
        }
        if (width === 0 || height === 0 || bitDepth !== 8 || interlace !== 0)
            return undefined;
        const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
        if (channels === 0)
            return undefined;
        const raw = inflateSync(Buffer.concat(compressed));
        const stride = width * channels;
        const previous = Buffer.alloc(stride);
        const current = Buffer.alloc(stride);
        let position = 0;
        let lit = 0;
        let sampled = 0;
        for (let y = 0; y < height; y += 1) {
            const filter = raw[position] ?? 0;
            position += 1;
            raw.copy(current, 0, position, Math.min(position + stride, raw.length));
            position += stride;
            for (let i = 0; i < stride; i += 1) {
                const left = i >= channels ? (current[i - channels] ?? 0) : 0;
                const up = previous[i] ?? 0;
                const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0;
                let value = current[i] ?? 0;
                if (filter === 1)
                    value += left;
                else if (filter === 2)
                    value += up;
                else if (filter === 3)
                    value += Math.floor((left + up) / 2);
                else if (filter === 4) {
                    const p = left + up - upLeft;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - up);
                    const pc = Math.abs(p - upLeft);
                    value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
                }
                current[i] = value & 0xff;
            }
            if (y % 8 === 0) {
                for (let x = 0; x < width; x += 8) {
                    const base = x * channels;
                    const red = current[base] ?? 0;
                    const green = channels >= 3 ? (current[base + 1] ?? 0) : red;
                    const blue = channels >= 3 ? (current[base + 2] ?? 0) : red;
                    sampled += 1;
                    if (red > 8 || green > 8 || blue > 8)
                        lit += 1;
                }
            }
            previous.set(current);
        }
        return { width, height, litRatio: sampled === 0 ? 0 : lit / sampled };
    }
    catch {
        return undefined;
    }
}
/** Build the plugin. */
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    const disposers = [];
    /**
     * Register one tool definition, keeping its disposer for teardown.
     *
     * Every description gets the version stamp here rather than at each call site, so
     * a tool added later cannot forget it: the stamp is what makes a stale Host
     * (serving a cached module) distinguishable from a reloaded one.
     */
    /** Consecutive \`xcode_build\` failures per working directory; cleared on success. */
    const buildFailureCounts = new Map();
    /**
     * Add the consecutive-failure reminder to \`xcode_build\`.
     *
     * A project that built a minute ago and now will not is usually not a code problem: a
     * leftover \`xcodebuild\` or a wedged DerivedData database is. Counting at registration
     * covers every return path of the tool, and declaring the extra fields here keeps its
     * declared output schema honest about what it can return.
     *
     * @param definition The registration about to be installed.
     * @returns The same definition, wrapped.
     */
    const withConsecutiveFailureHint = (definition) => {
        const output = definition.output;
        const schema = output?.schema;
        const properties = schema !== undefined && typeof schema.properties === 'object' && schema.properties !== null
            ? schema.properties
            : undefined;
        const originalExecute = definition.execute;
        const originalRender = output?.render;
        if (originalExecute === undefined || schema === undefined || properties === undefined) {
            return definition;
        }
        return {
            ...definition,
            output: {
                ...output,
                schema: {
                    ...schema,
                    properties: {
                        ...properties,
                        hint: { type: 'string' },
                        consecutiveFailures: { type: 'integer' },
                    },
                },
                // Rendered as a final block rather than folded into the existing text, so the
                // reminder cannot be lost inside a truncated build tail.
                render: (...renderArgs) => {
                    const blocks = originalRender === undefined ? [] : originalRender(...renderArgs);
                    const value = renderArgs[1];
                    const hint = typeof value?.hint === 'string' ? value.hint : undefined;
                    return hint === undefined ? blocks : [...blocks, textBlock(hint)];
                },
            },
            async execute(args, exec) {
                const result = await originalExecute(args, exec);
                const key = resolveCwd(config, args.cwd);
                if (result.ok === true) {
                    buildFailureCounts.delete(key);
                    return result;
                }
                const failures = (buildFailureCounts.get(key) ?? 0) + 1;
                buildFailureCounts.set(key, failures);
                if (failures < CONSECUTIVE_BUILD_FAILURES)
                    return result;
                return {
                    ...result,
                    consecutiveFailures: failures,
                    hint: `检测到连续失败 ${failures} 次，建议调用 cleanup_environment 清理缓存` +
                        '（残留的 xcodebuild 进程或 DerivedData 构建数据库可能仍在阻塞构建）',
                };
            },
        };
    };
    const register = (definition) => {
        const description = typeof definition.description === 'string' ? definition.description : '';
        const stamped = {
            ...definition,
            description: description.includes(VERSION_STAMP)
                ? description
                : `${description} ${VERSION_STAMP}`.trim(),
        };
        disposers.push(ctx.tools.register(definition.name === 'xcode_build' ? withConsecutiveFailureHint(stamped) : stamped));
    };
    /**
     * Run one `idb` invocation, healing a stale companion registry once.
     *
     * `idb` is the only route to touch injection: `simctl` exposes no tap. The
     * first call in a session also starts the `idb_companion` daemon, which is why
     * `idbTimeoutMs` is generous.
     */
    const runIdb = async (args, cwd, signal, notes) => {
        const invoke = () => runCommand(ctx, config, {
            argv: [expandHome(config.idbPath), ...args],
            cwd,
            timeoutMs: config.idbTimeoutMs,
            ...(signal !== undefined ? { signal } : {}),
        });
        const first = await invoke();
        // A dead companion leaves a record behind; repair and retry exactly once.
        if (first.unavailable || first.exitCode === 0)
            return first;
        if (!/Failed to connect to companion/i.test(first.output))
            return first;
        const removed = pruneUnreachableIdbCompanions();
        if (removed === 0)
            return first;
        notes?.push(`removed ${removed} unreachable companion record(s) from ${IDB_STATE_FILE_PATH} and retried`);
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
    const captureScreen = async (options) => {
        const destination = options.path !== undefined
            ? isAbsolute(options.path)
                ? options.path
                : join(options.cwd, options.path)
            : join(options.cwd, config.screenshotDir, `${options.prefix}-${fileTimestamp()}.png`);
        // simctl will not create intermediate directories, so make them first.
        const directory = dirname(destination);
        try {
            mkdirSync(directory, { recursive: true });
        }
        catch (error) {
            return {
                ok: false,
                failure: `could not create the screenshot directory ${directory}: ${describeError(error)}`,
                path: destination,
            };
        }
        const captured = await runCommand(ctx, config, {
            // `--display` selects one panel. A folded-away panel captures as a black frame, so
            // naming the panel is the difference between a usable image and an empty one. The
            // accepted values are the ones `simctl io <device> enumerate` reports: a screen name
            // like `LCD`/`LCD-1`, a numeric screen ID, `primary`, or a screen/port UUID.
            argv: [
                config.xcrunPath,
                'simctl',
                'io',
                options.udid,
                'screenshot',
                ...(options.display !== undefined ? [`--display=${options.display}`] : []),
                destination,
            ],
            cwd: options.cwd,
            timeoutMs: config.simctlTimeoutMs,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        if (captured.unavailable)
            return { ok: false, failure: captured.output, path: destination };
        if (captured.exitCode !== 0) {
            return {
                ok: false,
                failure: `screenshot failed: ${bounded(captured.output, 2000).text}`,
                path: destination,
                ...(captured.exitCode !== null ? { exitCode: captured.exitCode } : {}),
            };
        }
        // A zero exit code is not proof of a file: verify the PNG really landed.
        let bytes;
        try {
            bytes = statSync(destination).size;
        }
        catch {
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
        let image;
        if (options.attach) {
            const attachments = attachmentsOf(ctx);
            if (attachments === undefined) {
                options.notes.push('the `attachments` service is not available here, so only the path is returned');
            }
            else {
                try {
                    const reference = await attachments.saveImage({
                        data: readFileSync(destination),
                        mediaType: 'image/png',
                        name: basename(destination),
                    });
                    image = { ...reference };
                }
                catch (error) {
                    options.notes.push(`could not attach the capture to this conversation: ${describeError(error)}; ` +
                        'the file is still on disk at the path above');
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
        description: 'Build, test, or clean an Xcode workspace/project with `xcodebuild`, then parse the compiler ' +
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
                    description: 'Build configuration, e.g. `Debug` or `Release`, appended as `-configuration <value>`. When ' +
                        "omitted, xcodebuild uses the scheme's own build configuration (usually Debug) rather than " +
                        'this tool forcing one.',
                },
                destination: {
                    type: 'string',
                    description: 'Full -destination value, e.g. `platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5`. ' +
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
                    description: 'Test identifiers to constrain a test action to, each appended as `-only-testing:<id>`. ' +
                        'Identifiers have the form `TestTarget[/TestClass[/TestMethod]]`, e.g. ' +
                        '["LunisolarCalendarUITests"] or ["LunisolarCalendarUITests/CalendarUITests/testLaunch"]. ' +
                        'Repeat the array to constrain several identifiers. Only meaningful for the test actions ' +
                        '(`test`, `test-without-building`, `build-for-testing`).',
                },
                shutdown_simulators: {
                    type: 'boolean',
                    description: 'Before a test action, run `xcrun simctl shutdown all` so `xcodebuild` boots its own simulator ' +
                        'from a clean state. Defaults to false, where the tool only warns when simulators are already ' +
                        'booted. Measured on this project: a UI channel run with leftover simulator state produced ' +
                        'random single-test failures that read as business bugs, so passing true is the safe choice ' +
                        'before UI tests — note that it does shut down simulators you may be using interactively.',
                },
                derived_data_path: {
                    type: 'string',
                    description: 'Per-call -derivedDataPath override, absolute or relative to `cwd`. Wins over the plugin ' +
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
            render(_args, value) {
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
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const started = Date.now();
            let target = isNonEmptyString(args.target) ? args.target.trim() : undefined;
            let scheme = isNonEmptyString(args.scheme) ? args.scheme.trim() : undefined;
            // An explicit `target` that does not exist is the most common path mistake.
            // xcodebuild would report it too, but only after a full process start, and
            // its message does not say what is actually there. Fail fast instead, and
            // name the candidates sitting in the directory.
            if (target !== undefined) {
                const targetPath = isAbsolute(target) ? target : join(cwd, target);
                if (!existsSync(targetPath)) {
                    let candidates = [];
                    try {
                        candidates = readdirSync(cwd).filter((entry) => entry.endsWith('.xcodeproj') || entry.endsWith('.xcworkspace'));
                    }
                    catch {
                        candidates = [];
                    }
                    return {
                        ok: false,
                        summary: `no \`${target}\` at ${targetPath}. ` +
                            (candidates.length > 0
                                ? `Found instead: ${candidates.join(', ')}. `
                                : `No .xcodeproj/.xcworkspace in ${cwd} either. `) +
                            'Pass an existing path, or omit `target` to let it auto-discover the project.',
                        command: 'xcodebuild',
                        target,
                        errorCount: 0,
                        warningCount: 0,
                        notes,
                    };
                }
            }
            if (target === undefined || scheme === undefined) {
                const discovered = await discoverProject(ctx, config, cwd, exec.signal);
                if (discovered.detectionLog.length > 0)
                    notes.push(discovered.detectionLog);
                if (target === undefined) {
                    target = discovered.target;
                    if (target !== undefined)
                        notes.push(`auto-discovered target: ${target}`);
                }
                if (scheme === undefined) {
                    if (discovered.schemes.length === 1) {
                        scheme = discovered.schemes[0];
                        notes.push(`auto-selected the only scheme: ${scheme}`);
                    }
                    else if (discovered.schemes.length > 1) {
                        // A one-click build must not stall on a multi-scheme project. Prefer
                        // the scheme that names the target itself — Xcode's convention is
                        // that the app target's scheme matches the project/workspace name,
                        // and only when nothing matches is a human choice really required.
                        const preferred = target !== undefined ? preferredScheme(discovered.schemes, target) : undefined;
                        if (preferred !== undefined) {
                            scheme = preferred;
                            notes.push(`auto-selected scheme: ${scheme} (matches ${target}); ` +
                                `pass \`scheme\` to build another one of: ${discovered.schemes.join(', ')}`);
                        }
                        else {
                            return {
                                ok: false,
                                summary: `No scheme matches ${target}. Pass \`scheme\` explicitly. ` +
                                    `Available: ${discovered.schemes.join(', ')}`,
                                command: 'xcodebuild -list',
                                errorCount: 0,
                                warningCount: 0,
                                notes,
                            };
                        }
                    }
                }
                if (discovered.diagnostics.length > 0)
                    notes.push(bounded(discovered.diagnostics, 2000).text);
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
            // Command assembly lives in a pure function so the exact argv can be tested
            // directly; the side effects that prepare a run (project discovery, the target
            // preflight, `simctl shutdown all`) stay in this method.
            const invocation = buildXcodeInvocation({ args, config, cwd, action, target, scheme });
            if ('error' in invocation) {
                return {
                    ok: false,
                    summary: invocation.error,
                    command: 'xcodebuild',
                    target,
                    errorCount: 0,
                    warningCount: 0,
                    notes,
                };
            }
            notes.push(...invocation.notes);
            const argv = invocation.argv;
            const destination = invocation.destination;
            const usedDerivedData = invocation.derivedDataPath;
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
                        notes.push('ran `simctl shutdown all` first (shutdown_simulators: true), so xcodebuild boots a clean simulator');
                    }
                    else {
                        notes.push(`\`simctl shutdown all\` did not succeed: ${bounded(shutdown.output, 400).text}`);
                    }
                }
                else {
                    const booted = await bootedSimulatorNames(ctx, config, cwd, exec.signal);
                    if (booted.length > 0) {
                        notes.push(`${booted.length} simulator(s) are already booted (${booted.join(', ')}); this project's UI ` +
                            'channels flake on leftover or parallel simulator state, which surfaces as random single-test ' +
                            'failures that look like business bugs — pass `shutdown_simulators: true` to shut them down first');
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
            const { items: diagnostics, omitted } = parseDiagnostics(result.output, config.maxDiagnostics);
            const errorCount = diagnostics.filter((item) => item.severity === 'error').length + omitted.error;
            const warningCount = diagnostics.filter((item) => item.severity === 'warning').length + omitted.warning;
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
            const killedByBudget = stoppedByBudget(result);
            if (killedByBudget) {
                notes.push(`xcodebuild exceeded ${config.buildTimeoutMs} ms and was terminated`);
            }
            else if (outlivedBudget(result)) {
                // The timer fired, but the build had already finished by itself; calling
                // that a termination would be false, and an exit 0 here is a success.
                notes.push(`xcodebuild exceeded ${config.buildTimeoutMs} ms but had already finished on its own ` +
                    `(exit ${String(result.exitCode)})`);
            }
            else if (result.timedOut) {
                notes.push(`xcodebuild exceeded ${config.buildTimeoutMs} ms and ended without reporting an exit status`);
            }
            if (result.quiescenceUnproven === true) {
                notes.push('the xcodebuild process exited but its child processes were not confirmed gone within the ' +
                    'grace window; compiling children (swiftc/clang) may still be finishing in the background');
            }
            if (result.lossy)
                notes.push('build output overflowed the in-memory budget and some output was dropped');
            if (result.exitCode !== 0 && diagnostics.length === 0) {
                notes.push('xcodebuild exited nonzero but no diagnostic line matched; the cause is in the output tail below');
            }
            const warningsAreFatal = config.treatWarningsAsErrors && warningCount > 0;
            if (warningsAreFatal) {
                notes.push('this project treats compiler warnings as failures (treatWarningsAsErrors); ' +
                    'set treatWarningsAsErrors: false in the plugin config to relax it');
            }
            // The bullets are capped to protect the context; say so rather than letting
            // the caller read a partial list as the whole story.
            if (omitted.error + omitted.warning > 0) {
                notes.push(`only the first ${config.maxDiagnostics} error/warning bullets are listed; ` +
                    `${omitted.error} more error(s) and ${omitted.warning} more warning(s) were omitted — ` +
                    'raise maxDiagnostics in the plugin config to see them');
            }
            // A test action that filters every test away still exits 0 with
            // `** TEST SUCCEEDED **`; treat "nothing ran" as the failed request it is,
            // otherwise a typo in `onlyTesting` looks like a green run.
            const executedTests = countExecutedTests(result.output);
            const runsTests = RUNS_TESTS.has(action);
            const noTestsRan = runsTests && executedTests === 0;
            if (noTestsRan) {
                notes.push('xcodebuild reported success but executed 0 tests — the `onlyTesting` identifiers matched ' +
                    'nothing, so check the spelling against `xcodebuild -list` / the test navigator');
            }
            if (runsTests && executedTests !== undefined) {
                notes.push(`xcodebuild executed ${executedTests} test(s)`);
            }
            const ok = result.exitCode === 0 && errorCount === 0 && !warningsAreFatal && !killedByBudget && !noTestsRan;
            const elapsed = Math.round((Date.now() - started) / 1000);
            const verdict = noTestsRan
                ? `xcodebuild ${action} ran no tests in ${elapsed}s`
                : ok
                    ? `xcodebuild ${action} succeeded in ${elapsed}s`
                    : killedByBudget
                        ? `xcodebuild ${action} was terminated after ${config.buildTimeoutMs} ms`
                        : `xcodebuild ${action} failed (exit ${result.exitCode ?? result.signal ?? 'unknown'}) after ${elapsed}s`;
            const counts = `${errorCount} error(s), ${warningCount} warning(s) parsed`;
            // A failed build whose cause is a write-permission error says so up front: the
            // raw output names no cause, and a tail is easy to miss.
            const blockedCause = ok ? undefined : describeWriteBlockedCause(result.output);
            if (blockedCause !== undefined)
                notes.push(`xcodebuild hit ${blockedCause}`);
            return {
                ok,
                summary: `${verdict}${blockedCause !== undefined ? ` — ${blockedCause}` : ''} — ${counts}`,
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
        description: 'Inspect the Xcode project next to the current directory: the workspace/project path and its ' +
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
            render(_args, value) {
                // The model only sees these content blocks, so a note it must act on has
                // to be rendered here rather than left in the structured field.
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const discovered = await discoverProject(ctx, config, cwd, exec.signal);
            const runtimes = await runCommand(ctx, config, {
                argv: [config.xcrunPath, 'simctl', 'list', 'runtimes', '-j'],
                cwd,
                timeoutMs: config.simctlTimeoutMs,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            const runtimeNames = [];
            const runtimesDocument = parseJsonObject(runtimes.output);
            if (runtimesDocument === undefined) {
                if (runtimes.output.trim().length > 0)
                    notes.push('could not parse `simctl list runtimes -j` output');
            }
            else {
                const list = runtimesDocument.runtimes;
                for (const runtime of Array.isArray(list) ? list : []) {
                    if (runtime.isAvailable === false)
                        continue;
                    const name = String(runtime.name ?? '');
                    const version = String(runtime.version ?? '');
                    runtimeNames.push(version.length > 0 ? `${name} (${version})` : name);
                }
            }
            if (discovered.schemes.length === 0)
                notes.push('no schemes were discovered');
            const lines = [
                `target: ${discovered.target ?? '(none found in ' + cwd + ')'}`,
                `schemes: ${discovered.schemes.length > 0 ? discovered.schemes.join(', ') : '(none)'}`,
                `runtimes: ${runtimeNames.length > 0 ? runtimeNames.join(', ') : '(none)'}`,
            ];
            if (discovered.diagnostics.length > 0)
                notes.push(bounded(discovered.diagnostics, 1500).text);
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
        description: 'Resolve an iOS project\'s dependencies before a first build. Detects `Podfile` and `Package.swift` in ' +
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
                    description: 'Directory holding the manifests. Defaults to the plugin working directory (the configured ' +
                        '`workspaceRoot`, i.e. the repository root).',
                },
                timeout_ms: {
                    type: 'number',
                    description: 'Per-command budget in milliseconds. Defaults to `dependenciesTimeoutMs` (300000, i.e. 5 ' +
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
            render(_args, value) {
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const blocks = [];
                const results = Array.isArray(value.results) ? value.results : [];
                for (const entry of results) {
                    if (entry === null || typeof entry !== 'object')
                        continue;
                    const record = entry;
                    const verdict = record.ok === true ? 'ok' : 'FAILED';
                    blocks.push(`${String(record.manager)} (${String(record.manifest)}) — ${verdict}` +
                        `${record.exitCode !== undefined ? ` exit=${String(record.exitCode)}` : ''}` +
                        ` in ${Math.round(Number(record.elapsedMs ?? 0) / 1000)}s\n$ ${String(record.command)}` +
                        (isNonEmptyString(record.output) ? `\n--- last output ---\n${record.output}` : ''));
                }
                const parts = [
                    value.summary,
                    blocks.join('\n\n'),
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const timeoutMs = Math.floor(positiveNumber(args.timeout_ms, config.dependenciesTimeoutMs, 1000, 60 * 60 * 1000));
            // Auto-detect by manifest file, not by a flag: whichever a project uses is
            // already on disk. A project may legitimately carry both (a Podfile plus a
            // local SwiftPM package), so each detected manifest gets its command.
            const plans = [];
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
                    summary: `neither a Podfile nor a Package.swift exists in ${cwd}; nothing to resolve. ` +
                        'Pass `cwd` if the manifest lives in a subdirectory.',
                    results: [],
                    notes,
                };
            }
            const results = [];
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
                if (stoppedByBudget(outcome)) {
                    notes.push(`${command} exceeded ${timeoutMs} ms and was terminated`);
                }
                else if (outlivedBudget(outcome)) {
                    notes.push(`${command} exceeded ${timeoutMs} ms but had already finished on its own (exit ${String(outcome.exitCode)})`);
                }
                else if (outcome.timedOut) {
                    notes.push(`${command} exceeded ${timeoutMs} ms and ended without reporting an exit status`);
                }
                if (outcome.quiescenceUnproven === true) {
                    notes.push(`${plan.manager}: the process exited but its child processes were not confirmed gone within ` +
                        'the grace window');
                }
                if (outcome.lossy) {
                    notes.push(`${plan.manager} output overflowed the in-memory budget and some output was dropped`);
                }
                // A process that never started reports no exit status and no signal: the
                // executor could not launch it, which almost always means the CLI is
                // absent. Say that outright — "failed in 0s" with empty output would hide
                // the one thing the caller needs to fix.
                const launched = outcome.exitCode !== null || outcome.timedOut;
                if (!launched && outcome.signal === null) {
                    notes.push(`${plan.manager}: \`${plan.executable}\` could not be launched — it is not installed or not on ` +
                        `PATH. Install it, or set \`${plan.configKey}\` in the plugin config to its absolute path.`);
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
                    ok: outcome.exitCode === 0 && !stoppedByBudget(outcome),
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
                const state = entry.ok === true
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
        description: 'Control iOS simulators through `xcrun simctl`: boot, shutdown, list devices, and inspect the ' +
            'currently booted device. `open` also brings the Simulator app to the front. Destructive ' +
            'actions (`erase`, `delete`) require `confirm: true`.',
        isConcurrencySafe: () => false,
        timeoutMs: config.simctlTimeoutMs + 30000,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    // Generated from the same set the executor validates against, so the
                    // advertised values and the accepted ones cannot drift apart.
                    enum: [...SIMULATOR_ACTIONS],
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
            render(_args, value) {
                // The model only sees these content blocks, so a note it must act on has
                // to be rendered here rather than left in the structured field.
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const action = isNonEmptyString(args.action) ? args.action.trim() : 'list';
            const notes = [];
            const run = (argv) => runCommand(ctx, config, {
                argv: [config.xcrunPath, 'simctl', ...argv],
                cwd,
                timeoutMs: config.simctlTimeoutMs,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            // Validate before doing anything else: an unknown verb must not reach
            // `simctl`, whose reply would be a usage dump naming no culprit.
            if (!SIMULATOR_ACTIONS.has(action)) {
                return {
                    ok: false,
                    action,
                    summary: `unknown action ${JSON.stringify(action)}; valid actions are: ` +
                        `${[...SIMULATOR_ACTIONS].join(', ')}`,
                    notes,
                };
            }
            if (action === 'list') {
                const runtimeFilter = isNonEmptyString(args.runtime) ? args.runtime.trim() : undefined;
                const listed = await run(['list', 'devices', 'available', '-j']);
                if (listed.unavailable)
                    return { ok: false, action, summary: listed.output, notes };
                const document = parseJsonObject(listed.output);
                if (document === undefined)
                    return { ok: false, action, summary: bounded(listed.output, 4000).text, notes };
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
                const resolved = await resolveDevice(ctx, config, cwd, undefined, exec.signal);
                if (resolved.udid === undefined) {
                    return { ok: false, action, summary: messageOr(resolved.note, 'no booted simulator'), notes };
                }
                const described = await run(['list', 'devices', 'booted', '-j']);
                const document = parseJsonObject(described.output);
                let label = resolved.udid;
                if (document !== undefined) {
                    const device = Object.values(deviceGroups(document)).flat()[0];
                    if (device !== undefined)
                        label = `${String(device.name)} [${String(device.state)}] ${resolved.udid}`;
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
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return { ok: false, action, summary: messageOr(resolved.note, 'no matching simulator'), notes };
            }
            const udid = resolved.udid;
            if (action === 'open') {
                // `open -a Simulator` only fronts the UI; boot the device first so the
                // window actually shows this simulator. The boot result used to be
                // discarded, which let a failed boot still report "opened Simulator".
                const booted = await run(['boot', udid]);
                const bootFailed = booted.exitCode !== 0 && !/current state:\s*Booted/i.test(booted.output);
                if (bootFailed) {
                    notes.push(`could not boot ${udid} before opening the Simulator app: ${bounded(booted.output, 500).text}`);
                }
                const opened = await runCommand(ctx, config, {
                    argv: ['/usr/bin/open', '-a', 'Simulator'],
                    cwd,
                    timeoutMs: 30000,
                    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
                });
                if (opened.exitCode !== 0)
                    notes.push(bounded(opened.output, 500).text);
                const ok = opened.exitCode === 0 && !bootFailed;
                return {
                    ok,
                    action,
                    summary: ok
                        ? `opened Simulator with ${udid}`
                        : `could not open Simulator with ${udid}` +
                            (bootFailed ? ' (the device could not be booted)' : ' (the Simulator app did not launch)'),
                    udid,
                    ...(opened.exitCode !== null ? { exitCode: opened.exitCode } : {}),
                    notes,
                };
            }
            const result = await run([action, udid]);
            // simctl reports the benign "already there" case as an error: booting an
            // already-booted device, and shutting down one that is already shut down
            // (measured: CoreSimulator code 405, "current state: Shutdown", exit 149).
            // Treat each as the success it is, but only for the state that action asks
            // for — "current state: Booted" must never excuse a failed shutdown.
            const benignState = action === 'boot'
                ? /current state:\s*Booted/i
                : action === 'shutdown'
                    ? /current state:\s*Shutdown/i
                    : null;
            const alreadyInState = benignState !== null && benignState.test(result.output);
            if (alreadyInState)
                notes.push('device was already in the requested state');
            const ok = result.exitCode === 0 || alreadyInState;
            const summary = bounded(ok
                ? `${action} ${udid}: ${result.output.trim().length > 0 ? result.output.trim() : 'ok'}`
                : `${action} ${udid} failed: ${result.output.trim()}`, 3000).text;
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
        description: 'Install a built `.app` bundle onto a simulator and launch it (`xcrun simctl install` + `launch`). ' +
            'Pass the `.app` product from an `xcode_build` run; `bundle_id` is required for launching and is ' +
            'optional when only installing.',
        isConcurrencySafe: () => false,
        // A ceiling, not a wait: boot (1x) + install with its one retry (2x) + launch
        // (4x when `--console-pty` streams until the app exits) = 7x, plus slack.
        // Declaring less than the worst case would let the harness cancel a call that
        // is still legitimately working — the install retry below would then never be
        // able to finish.
        timeoutMs: config.simctlTimeoutMs * 7 + 30000,
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
            render(_args, value) {
                // The model only sees these content blocks, so a note it must act on has
                // to be rendered here rather than left in the structured field.
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            if (!isNonEmptyString(args.app_path)) {
                return { ok: false, summary: 'app_path is required', appPath: '', notes };
            }
            const appPath = args.app_path.trim();
            const bundleId = isNonEmptyString(args.bundle_id) ? args.bundle_id.trim() : undefined;
            const shouldLaunch = args.launch === false ? false : bundleId !== undefined;
            if (shouldLaunch && bundleId === undefined) {
                return { ok: false, summary: 'bundle_id is required to launch the app', appPath, notes };
            }
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return { ok: false, summary: messageOr(resolved.note, 'no matching simulator'), appPath, notes };
            }
            const udid = resolved.udid;
            // Install and launch both require a booted device.
            const booted = await runCommand(ctx, config, {
                argv: [config.xcrunPath, 'simctl', 'boot', udid],
                cwd,
                timeoutMs: config.simctlTimeoutMs,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            if (booted.exitCode !== 0 && !/current state:\s*Booted/i.test(booted.output)) {
                notes.push(`boot reported: ${bounded(booted.output, 300).text}`);
            }
            // A large `.app` can take a long time to copy into the device container, so
            // the install gets its own retry-and-report treatment: one retry on a
            // recognised infrastructure flake (never on a timeout — that would just
            // double the wait), an explicit timeout message, and the elapsed time so the
            // caller can see whether the bundle is what made it slow.
            const installArgv = [config.xcrunPath, 'simctl', 'install', udid, appPath];
            const installStarted = Date.now();
            let installed = await runCommand(ctx, config, {
                argv: installArgv,
                cwd,
                timeoutMs: config.simctlTimeoutMs,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            // Never retry after a cancellation: the signal is already aborted, so the
            // second spawn would fail immediately and be reported as "could not be
            // launched", blaming a missing CLI for the caller's own cancellation.
            const callerAborted = exec.signal?.aborted === true;
            if (installed.exitCode !== 0 &&
                !installed.timedOut &&
                !callerAborted &&
                FLAKY_SIMCTL_PATTERN.test(installed.output)) {
                notes.push('the install hit a simulator infrastructure flake; waiting 1s and retrying once ' +
                    `(matched ${bounded(installed.output, 200).text.trim()})`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
                installed = await runCommand(ctx, config, {
                    argv: installArgv,
                    cwd,
                    timeoutMs: config.simctlTimeoutMs,
                    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
                });
            }
            const installSeconds = ((Date.now() - installStarted) / 1000).toFixed(1);
            if (stoppedByBudget(installed)) {
                notes.push(`the install exceeded simctlTimeoutMs (${config.simctlTimeoutMs} ms) and was terminated; a large ` +
                    '`.app` can need longer — raise simctlTimeoutMs in the plugin config');
                return {
                    ok: false,
                    summary: `install timed out after ${config.simctlTimeoutMs} ms (waited ${installSeconds}s in total ` +
                        'before being stopped); the bundle may be very large',
                    appPath,
                    udid,
                    ...(bundleId !== undefined ? { bundleId } : {}),
                    notes,
                };
            }
            if (outlivedBudget(installed)) {
                // The budget expired, but the copy had already finished: calling that a
                // failure would report a successful install as a timeout.
                notes.push(`the install exceeded simctlTimeoutMs (${config.simctlTimeoutMs} ms) but completed on its own ` +
                    `(exit ${String(installed.exitCode)})`);
            }
            if (installed.exitCode !== 0) {
                return {
                    ok: false,
                    summary: `install failed: ${messageOr(bounded(installed.output, 3000).text, 'simctl install reported no output')}`,
                    appPath,
                    udid,
                    ...(bundleId !== undefined ? { bundleId } : {}),
                    ...(installed.exitCode !== null ? { exitCode: installed.exitCode } : {}),
                    notes,
                };
            }
            const lines = [`installed ${appPath} on ${udid} in ${installSeconds}s`];
            if (!shouldLaunch || bundleId === undefined) {
                return { ok: true, summary: lines.join('\n'), appPath, udid, notes };
            }
            if (args.terminate_existing === true) {
                await runCommand(ctx, config, {
                    argv: [config.xcrunPath, 'simctl', 'terminate', udid, bundleId],
                    cwd,
                    timeoutMs: config.simctlTimeoutMs,
                    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
                });
            }
            const launchArgv = [config.xcrunPath, 'simctl', 'launch'];
            if (args.console === true)
                launchArgv.push('--console-pty');
            launchArgv.push(udid, bundleId);
            if (Array.isArray(args.arguments)) {
                for (const entry of args.arguments) {
                    if (isNonEmptyString(entry))
                        launchArgv.push(entry);
                }
            }
            const launchTimeoutMs = args.console === true ? config.simctlTimeoutMs * 4 : config.simctlTimeoutMs;
            const launchStarted = Date.now();
            const launched = await runCommand(ctx, config, {
                argv: launchArgv,
                cwd,
                timeoutMs: launchTimeoutMs,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            const launchSeconds = ((Date.now() - launchStarted) / 1000).toFixed(1);
            const pidMatch = /:\s*(\d+)\s*$/.exec(launched.output.trim());
            const pid = pidMatch !== null ? Number(pidMatch[1]) : undefined;
            const ok = launched.exitCode === 0 || pid !== undefined;
            const launchIsTimeout = stoppedByBudget(launched);
            if (launchIsTimeout) {
                notes.push(`the launch exceeded ${launchTimeoutMs} ms and was terminated${args.console === true ? ' (--console-pty keeps streaming until the app exits)' : ''}; raise simctlTimeoutMs in the plugin config if the app needs longer to start`);
            }
            else if (outlivedBudget(launched)) {
                notes.push(`the launch exceeded ${launchTimeoutMs} ms but finished on its own (exit ${String(launched.exitCode)})`);
            }
            lines.push(ok
                ? `launched ${bundleId}${pid !== undefined ? ` (pid ${pid})` : ''} in ${launchSeconds}s`
                : launchIsTimeout
                    ? `launch timed out after ${launchTimeoutMs} ms`
                    : `launch failed: ${messageOr(bounded(launched.output, 2000).text, 'simctl launch reported no output')}`);
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
        description: 'Capture the current screen of a booted iOS simulator to a PNG with ' +
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
                    description: 'Explicit destination file, absolute or relative to `cwd`. Defaults to ' +
                        '`<cwd>/<screenshotDir>/screenshot-<timestamp>.png`.',
                },
                display: {
                    type: 'string',
                    description: 'Capture one panel instead of the default screen, passed as `--display=<value>`. On a ' +
                        'foldable such as `iPhone Duo` the panels are `LCD` (outer) and `LCD-1` (inner), and a ' +
                        'folded-away panel captures as black unless it is named. Valid values are what ' +
                        '`xcrun simctl io <device> enumerate` lists: a screen name, a screen ID, `primary`, or a ' +
                        'UUID. Omit it to keep the single-screen behaviour.',
                },
                cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
                attach: {
                    type: 'boolean',
                    description: 'Also attach the capture to this conversation as an image so it can be seen directly, ' +
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
            render(_args, value) {
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                    // The absolute path is the whole point of the tool, so render it
                    // rather than trusting the caller to read the structured field.
                    isNonEmptyString(value.path) ? `image: ${value.path}` : undefined,
                ].filter(isNonEmptyString);
                const blocks = [textBlock(parts.join('\n\n'))];
                // An ImageBlock is what lets the model actually look at the capture.
                if (value.image !== undefined)
                    blocks.push({ type: 'image', attachment: value.image });
                return blocks;
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return {
                    ok: false,
                    summary: messageOr(resolved.note, 'no booted simulator; boot one with simulator_control first'),
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
                ...(isNonEmptyString(args.display) ? { display: args.display.trim() } : {}),
                notes,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
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
        description: 'Listen to the booted simulator\'s unified log for a short window with ' +
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
            render(_args, value) {
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                    value.logs,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return {
                    ok: false,
                    summary: messageOr(resolved.note, 'no booted simulator; boot one with simulator_control first'),
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
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
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
            }
            else if (matched > entries.length) {
                notes.push(`kept the newest ${entries.length} of ${matched} matching entries`);
            }
            const text = entries.map(formatLogEntry).join('\n');
            const boundedText = boundedTail(text, config.maxOutputChars);
            if (boundedText.truncated) {
                notes.push(`the rendered log was trimmed to the newest ${config.maxOutputChars} characters`);
            }
            return {
                ok: true,
                summary: `listened ${seconds}s on ${udid} — ${matched} error/fault entry(ies), ` +
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
        description: 'Tap the booted iOS simulator, either at an absolute screen point or on the element that owns an ' +
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
                    description: 'Accessibility identifier (AXUniqueId, or its label) of the element to tap. Its frame centre ' +
                        'is tapped instead of `x`/`y`. Discover identifiers with simulator_elements.',
                },
                device: { type: 'string', description: 'Simulator name, UDID, or `booted`. Defaults to the booted device.' },
                cwd: { type: 'string', description: 'Directory to run in. Defaults to the plugin working directory.' },
                screenshot: {
                    type: 'boolean',
                    description: 'Capture the screen once the tap settles and attach it to this conversation, so the outcome ' +
                        'is visible without a second call. Defaults to true; pass false to only tap.',
                },
                settle_ms: {
                    type: 'number',
                    description: 'How long to wait after the tap before capturing, so an animation is not caught mid-flight. ' +
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
            render(_args, value) {
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    value.element !== undefined ? `element: ${value.element}` : undefined,
                    value.x !== undefined && value.y !== undefined ? `tapped at: (${value.x}, ${value.y})` : undefined,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                    isNonEmptyString(value.screenshotPath) ? `screenshot: ${value.screenshotPath}` : undefined,
                ].filter(isNonEmptyString);
                const blocks = [textBlock(parts.join('\n\n'))];
                // The post-tap capture is the point of the combined call: show it.
                if (value.image !== undefined)
                    blocks.push({ type: 'image', attachment: value.image });
                return blocks;
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const accessibilityId = isNonEmptyString(args.accessibility_id) ? args.accessibility_id.trim() : undefined;
            const hasPoint = numberOf(args.x) !== undefined && numberOf(args.y) !== undefined;
            if (accessibilityId === undefined && !hasPoint) {
                return {
                    ok: false,
                    summary: 'pass either `x` and `y`, or `accessibility_id`',
                    notes,
                };
            }
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return {
                    ok: false,
                    summary: messageOr(resolved.note, 'no booted simulator; boot one with simulator_control first'),
                    notes,
                };
            }
            const udid = resolved.udid;
            let x = hasPoint ? Math.round(numberOf(args.x)) : 0;
            let y = hasPoint ? Math.round(numberOf(args.y)) : 0;
            let mode = 'coordinate';
            let elementLine;
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
                        summary: `no element matches ${JSON.stringify(accessibilityId)} among ${elements.length} elements; ` +
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
            let screenshotPath;
            let screenshotBytes;
            let screenshotImage;
            if (args.screenshot !== false) {
                const settleMs = Math.floor(positiveNumber(args.settle_ms, 700, 0, 10000));
                if (settleMs > 0)
                    await new Promise((resolve) => setTimeout(resolve, settleMs));
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
                }
                else {
                    notes.push(`the tap succeeded but the post-tap screenshot failed: ${captured.failure}`);
                }
            }
            return {
                ok: true,
                summary: mode === 'accessibility'
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
    // ---------------------------------------------------------------------------
    // Capability: acceptance-criteria UI verification
    // ---------------------------------------------------------------------------
    register({
        name: 'ios_verify_ui',
        description: 'Check the simulator screen against a plain-language acceptance criterion, e.g. ' +
            '"屏幕上应该出现日历和日期选择器". A tool cannot see, so this is a two-phase protocol: ' +
            'phase 1 captures the screen, attaches it to this conversation and hands back the criterion ' +
            'for you — the vision-capable model — to judge; phase 2 records that judgement by calling this ' +
            'tool again with `passed` (and `reason` when it failed), answering `{ passed: true }` or ' +
            '`{ passed: false, reason, nextSteps }`. Do both phases: a capture nobody judged verifies ' +
            'nothing. `ok` is false whenever the criterion is not met or the check could not run at all — ' +
            '`status` says which (`failed`, `capture-failed`, `no-device`, `invalid-arguments`).',
        // A capture and the verdict on it have to belong to one sequence: two verification
        // runs racing would each attach their own frame and the verdicts could be swapped.
        isConcurrencySafe: () => false,
        timeoutMs: config.simctlTimeoutMs + 30000,
        parameters: {
            type: 'object',
            properties: {
                acceptance_criteria: {
                    type: 'string',
                    description: 'What the screen must show, in plain language, e.g. "屏幕上应该出现日历和日期选择器". ' +
                        'Required in both phases so the verdict always carries the criterion it judged.',
                },
                passed: {
                    type: 'boolean',
                    description: 'Phase 2 only: your verdict after looking at the attached screenshot. Omit it entirely in ' +
                        'phase 1 — passing it means "record this judgement".',
                },
                reason: {
                    type: 'string',
                    description: 'Required when `passed` is false: what is missing or wrong, e.g. "未发现日期选择器" — ' +
                        'and say what the screen showed instead, so the caller can act on it.',
                },
                device: {
                    type: 'string',
                    description: 'Simulator name, UDID, or `booted`. Defaults to the booted device.',
                },
                path: {
                    type: 'string',
                    description: 'Phase 1 only: explicit screenshot destination, absolute or relative to `cwd`. Defaults to ' +
                        '`<cwd>/<screenshotDir>/verify-<timestamp>.png`, so a verification is never overwritten by ' +
                        'the next one.',
                },
                cwd: {
                    type: 'string',
                    description: 'Directory to run in. Defaults to the plugin working directory.',
                },
                attach: {
                    type: 'boolean',
                    description: 'Phase 1 only: attach the capture so it can be judged. Defaults to true; when attaching is ' +
                        'impossible the returned path can be read with the read_image tool instead.',
                },
            },
            required: ['acceptance_criteria'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                required: ['ok', 'summary', 'notes'],
                properties: {
                    ok: { type: 'boolean' },
                    summary: { type: 'string' },
                    // Absent in phase 1: the verdict does not exist until the model has looked.
                    passed: { type: 'boolean' },
                    reason: { type: 'string' },
                    status: {
                        type: 'string',
                        enum: [
                            'awaiting_vision_judgement',
                            'passed',
                            'failed',
                            'capture-failed',
                            'no-device',
                            'invalid-arguments',
                        ],
                    },
                    acceptanceCriteria: { type: 'string' },
                    screenshotPath: { type: 'string' },
                    udid: { type: 'string' },
                    attached: { type: 'boolean' },
                    instructions: { type: 'string' },
                    nextSteps: { type: 'array', items: { type: 'string' } },
                    exitCode: { type: 'integer' },
                    image: IMAGE_REF_SCHEMA,
                    notes: { type: 'array', items: { type: 'string' } },
                },
            },
            render(_args, value) {
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const nextSteps = Array.isArray(value.nextSteps) ? value.nextSteps.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    isNonEmptyString(value.reason) ? `reason: ${value.reason}` : undefined,
                    isNonEmptyString(value.instructions) ? value.instructions : undefined,
                    nextSteps.length > 0 ? `Next steps:\n${nextSteps.map((step) => `- ${step}`).join('\n')}` : undefined,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                ].filter(isNonEmptyString);
                const blocks = [textBlock(parts.join('\n\n'))];
                // The ImageBlock is what lets the model actually look at the screen.
                if (value.image !== undefined)
                    blocks.push({ type: 'image', attachment: value.image });
                return blocks;
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const criteria = isNonEmptyString(args.acceptance_criteria)
                ? args.acceptance_criteria.trim()
                : undefined;
            if (criteria === undefined) {
                return {
                    ok: false,
                    status: 'invalid-arguments',
                    summary: '`acceptance_criteria` is required: say what the screen must show, e.g. ' +
                        '"屏幕上应该出现日历和日期选择器"',
                    notes,
                };
            }
            // ---- Phase 2: record the judgement the model made from the capture --------
            if (typeof args.passed === 'boolean') {
                const reason = isNonEmptyString(args.reason) ? args.reason.trim() : undefined;
                if (args.passed) {
                    return {
                        ok: true,
                        passed: true,
                        status: 'passed',
                        acceptanceCriteria: criteria,
                        summary: `acceptance criteria met: ${criteria}`,
                        ...(isNonEmptyString(args.path) ? { screenshotPath: args.path.trim() } : {}),
                        notes,
                    };
                }
                if (reason === undefined) {
                    // A bare "it failed" is not actionable and cannot be audited later.
                    return {
                        ok: false,
                        passed: false,
                        status: 'invalid-arguments',
                        acceptanceCriteria: criteria,
                        summary: 'a failed verification must say what is wrong: call again with `reason`, e.g. ' +
                            '`reason: "未发现日期选择器"`, naming what the screen showed instead',
                        notes,
                    };
                }
                return {
                    ok: false,
                    passed: false,
                    status: 'failed',
                    reason,
                    acceptanceCriteria: criteria,
                    // The reason is a structured field and the render prints it once; repeating
                    // it here produced the same line twice in the model's view.
                    summary: `acceptance criteria NOT met: ${criteria}`,
                    nextSteps: [
                        'list what the screen actually shows with `simulator_elements` to pin the gap down',
                        'if the screen was mid-navigation or still animating, let it settle and re-run phase 1 — ' +
                            'do not conclude from a capture taken too early',
                        'if the UI is genuinely missing or wrong, fix the SwiftUI code, then `xcode_build` and ' +
                            '`simulator_install_launch`, and only then verify again',
                        'if the criterion itself is not something a screenshot can show (a haptic, a sound, ' +
                            'a network effect), say so rather than reporting a UI failure',
                    ],
                    ...(isNonEmptyString(args.path) ? { screenshotPath: args.path.trim() } : {}),
                    notes,
                };
            }
            // ---- Phase 1: capture and hand the criterion to the vision model ---------
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return {
                    ok: false,
                    status: 'no-device',
                    acceptanceCriteria: criteria,
                    summary: messageOr(resolved.note, 'no booted simulator is available; install and launch the app with ' +
                        '`simulator_install_launch` first'),
                    notes,
                };
            }
            const captured = await captureScreen({
                cwd,
                udid: resolved.udid,
                // A distinct prefix keeps verification captures apart from the plain
                // `simulator_screenshot` ones, so an acceptance run is easy to find later.
                prefix: 'verify',
                path: isNonEmptyString(args.path) ? args.path.trim() : undefined,
                attach: args.attach !== false,
                notes,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            if (!captured.ok) {
                return {
                    ok: false,
                    status: 'capture-failed',
                    acceptanceCriteria: criteria,
                    ...(captured.path !== undefined ? { screenshotPath: captured.path } : {}),
                    ...(captured.exitCode !== undefined ? { exitCode: captured.exitCode } : {}),
                    summary: `could not capture the screen: ${captured.failure}`,
                    notes,
                };
            }
            const attached = captured.image !== undefined;
            const where = attached ? 'attached screenshot' : `screenshot at ${captured.path}`;
            if (!attached) {
                notes.push('the capture could not be attached, so read the file at `screenshotPath` with the ' +
                    'read_image tool before judging it');
            }
            return {
                ok: true,
                status: 'awaiting_vision_judgement',
                acceptanceCriteria: criteria,
                screenshotPath: captured.path,
                udid: resolved.udid,
                attached,
                ...(captured.image !== undefined ? { image: captured.image } : {}),
                instructions: `Look at the ${where} and decide whether it satisfies: "${criteria}". ` +
                    'Then call ios_verify_ui again with the same `acceptance_criteria` and either ' +
                    '`passed: true`, or `passed: false` with a `reason` naming what is missing. ' +
                    'Judge only what the picture shows — if the capture is ambiguous or clearly mid-animation, ' +
                    'capture again instead of guessing.',
                summary: `captured ${captured.path} (${String(captured.bytes)} bytes)` +
                    `${attached ? ', attached for judging' : ''}; the criterion under test is: ${criteria}`,
                notes,
            };
        },
    });
    // ---------------------------------------------------------------------------
    // Capability: recover the machine after an interrupted run
    // ---------------------------------------------------------------------------
    /**
     * Names Xcode and SwiftPM leave behind when a build dies mid-flight.
     *
     * Measured on this machine's real DerivedData: `Build/Intermediates.noindex/
     * XCBuildData/build.db` plus a `<hash>.xcbuilddata` directory. They are the reason
     * a later build can sit at "database is locked", so they are what this tool looks
     * for — discovered by walking, not assumed by name-only folklore.
     */
    const LOCK_ARTIFACT_NAMES = new Set(['build.db', 'build.db-shm', 'build.db-wal']);
    const isLockArtifact = (name) => LOCK_ARTIFACT_NAMES.has(name) ||
        name.endsWith('.xcbuilddata') ||
        name.endsWith('.lock') ||
        name.endsWith('.lockfile');
    // ---------------------------------------------------------------------------
    // Capability: foldable (iPhone Duo) panel state
    // ---------------------------------------------------------------------------
    register({
        name: 'duo_fold_state',
        description: 'Report the panel state of a foldable simulator such as `iPhone Duo`. Panels come from ' +
            '`xcrun simctl io <device> enumerate` — `LCD` is the outer panel, `LCD-1` the inner one — and ' +
            'each integrated panel is captured and its pixels measured, so the tool can say which one is ' +
            'actually showing content — a folded-away panel is pure black yet still compresses to ~106 KB, so ' +
            'it reports `litRatio` (sampled non-black fraction) and `blank` (< 0.1%) instead of guessing from ' +
            'file size. ' +
            '**The hinge angle is not exposed by Xcode 27.1**: `devicectl` has no `device motion` subcommand, ' +
            '`devicectl device info displays` answers CoreDeviceError 1001 for a simulator, and ' +
            '`simctl io … enumerate` reports no posture field. The angle is therefore never invented — ' +
            '`angleUnavailable` says why, and the panel evidence is what is real.',
        isConcurrencySafe: () => false,
        timeoutMs: config.simctlTimeoutMs * 4 + 30000,
        parameters: {
            type: 'object',
            properties: {
                device: {
                    type: 'string',
                    description: 'Simulator name, UDID, device type (e.g. `iPhone-Duo` or ' +
                        '`com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`), or `booted`. Defaults to the booted device.',
                },
                capture: {
                    type: 'boolean',
                    description: 'Capture each integrated panel to decide which one is showing content. Defaults to true; ' +
                        'pass false to report the enumeration alone (no files are written).',
                },
                cwd: {
                    type: 'string',
                    description: 'Directory to run in. Defaults to the plugin working directory.',
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
                    udid: { type: 'string' },
                    foldable: { type: 'boolean' },
                    activePanel: { type: 'string' },
                    angleUnavailable: { type: 'string' },
                    panels: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['name'],
                            properties: {
                                id: { type: 'integer' },
                                name: { type: 'string' },
                                deviceName: { type: 'string' },
                                bytes: { type: 'integer' },
                                litRatio: { type: 'number' },
                                width: { type: 'integer' },
                                height: { type: 'integer' },
                                blank: { type: 'boolean' },
                                path: { type: 'string' },
                            },
                        },
                    },
                    exitCode: { type: 'integer' },
                    notes: { type: 'array', items: { type: 'string' } },
                },
            },
            render(_args, value) {
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const rows = (Array.isArray(value.panels) ? value.panels : [])
                    .filter((panel) => typeof panel === 'object' && panel !== null)
                    .map((panel) => {
                    const size = typeof panel.width === 'number' && typeof panel.height === 'number'
                        ? ` ${String(panel.width)}x${String(panel.height)}`
                        : '';
                    const capture = typeof panel.bytes === 'number'
                        ? `, ${String(panel.bytes)}B${panel.blank === true ? ' (blank)' : ''}`
                        : '';
                    return `- ${String(panel.name)} (id ${String(panel.id ?? '?')})${size}${capture}`;
                });
                const parts = [
                    value.summary,
                    rows.length > 0 ? `Panels:\n${rows.join('\n')}` : undefined,
                    isNonEmptyString(value.activePanel) ? `active panel: ${value.activePanel}` : undefined,
                    isNonEmptyString(value.angleUnavailable) ? `fold angle: ${value.angleUnavailable}` : undefined,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return {
                    ok: false,
                    summary: messageOr(resolved.note, 'no booted simulator; boot one with simulator_control first'),
                    notes,
                };
            }
            const udid = resolved.udid;
            const enumerated = await runCommand(ctx, config, {
                argv: [config.xcrunPath, 'simctl', 'io', udid, 'enumerate'],
                cwd,
                timeoutMs: config.simctlTimeoutMs,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            if (enumerated.unavailable)
                return { ok: false, udid, summary: enumerated.output, notes };
            if (enumerated.exitCode !== 0) {
                return {
                    ok: false,
                    udid,
                    ...(enumerated.exitCode !== null ? { exitCode: enumerated.exitCode } : {}),
                    summary: `could not enumerate the device's screens: ${bounded(enumerated.output, 800).text}`,
                    notes,
                };
            }
            const screens = parseEnumeratedScreens(enumerated.output);
            const integrated = screens.filter((screen) => (screen.screenType ?? '').toLowerCase() === 'integrated');
            const foldable = integrated.length > 1;
            const panels = [];
            if (args.capture !== false) {
                for (const screen of integrated) {
                    const captured = await captureScreen({
                        cwd,
                        udid,
                        prefix: `duo-${screen.name}`,
                        attach: false,
                        display: screen.name,
                        notes,
                        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
                    });
                    if (!captured.ok) {
                        notes.push(`could not capture panel ${screen.name}: ${captured.failure}`);
                        continue;
                    }
                    const stats = pngStats(captured.path);
                    if (stats === undefined) {
                        notes.push(`could not measure panel ${screen.name} (unsupported PNG layout); its ` +
                            `${String(captured.bytes)}-byte capture is reported without a blank verdict`);
                    }
                    panels.push({
                        ...(screen.id !== undefined ? { id: screen.id } : {}),
                        name: screen.name,
                        ...(screen.deviceName !== undefined ? { deviceName: screen.deviceName } : {}),
                        bytes: captured.bytes,
                        ...(stats !== undefined
                            ? {
                                width: stats.width,
                                height: stats.height,
                                litRatio: Number(stats.litRatio.toFixed(4)),
                            }
                            : {}),
                        // Measured from the pixels: a fully black 2007x2853 panel is still ~106 KB, so a
                        // byte-count threshold used to call it content.
                        // A truly folded-away panel measures exactly 0; a dark-but-real UI still
                        // lights up far more than 0.1% of its sampled pixels.
                        ...(stats !== undefined ? { blank: stats.litRatio < 0.001 } : {}),
                        path: captured.path,
                    });
                }
            }
            else {
                for (const screen of integrated) {
                    panels.push({
                        ...(screen.id !== undefined ? { id: screen.id } : {}),
                        name: screen.name,
                        ...(screen.deviceName !== undefined ? { deviceName: screen.deviceName } : {}),
                    });
                }
            }
            const lit = panels
                .filter((panel) => panel.blank === false && typeof panel.litRatio === 'number')
                .sort((left, right) => Number(right.litRatio) - Number(left.litRatio));
            const activePanel = typeof lit[0]?.name === 'string' ? lit[0].name : undefined;
            if (panels.length > 0) {
                notes.push(`panel measurements: ${panels
                    .map((panel) => `${String(panel.name)}=${String(panel.bytes ?? 'not captured')}` +
                    `${panel.blank === true ? ' (blank)' : ''}`)
                    .join(', ')}`);
            }
            const summary = [
                `device: ${udid} — ${foldable ? 'foldable' : 'single'} integrated panel(s)`,
                `panels: ${panels.length > 0
                    ? panels.map((panel) => `${String(panel.name)} (id ${String(panel.id ?? '?')})`).join(', ')
                    : '(none enumerated)'}`,
                `active panel: ${activePanel ?? '(not determined)'}`,
                'hinge angle: not exposed on this toolchain (see angleUnavailable)',
            ].join('\n');
            return {
                ok: true,
                udid,
                foldable,
                panels,
                ...(activePanel !== undefined ? { activePanel } : {}),
                angleUnavailable: 'Xcode 27.1 exposes no fold angle to the host: `devicectl` has no `device motion` ' +
                    'subcommand (only `orientation get|set|rotate`, which is screen rotation), ' +
                    '`devicectl device info displays` answers CoreDeviceError 1001 ' +
                    '(`com.apple.coredevice.feature.getdisplayinfo`) for a simulator, and ' +
                    '`simctl io … enumerate` carries no posture field. Panels and their capture state are ' +
                    'reported instead, because those are real.',
                summary,
                notes,
            };
        },
    });
    register({
        name: 'cleanup_environment',
        description: 'Recover the machine after an interrupted iOS run: terminate leftover `xcodebuild` processes that ' +
            'belong to this workspace, plus simulator-scoped `simctl … log stream` and `idb_companion` processes ' +
            'left behind by an interrupted run (those are matched by device UDID, since their command line never ' +
            'belong to this workspace, drop stale DerivedData build-database/lock artifacts, and shut down every ' +
            'booted simulator. **It only reports unless `auto_clean: true`.** An `xcodebuild` whose command line ' +
            'does not name this workspace or DerivedData is never touched, so a build you started yourself in ' +
            'Xcode elsewhere survives. Termination is SIGTERM, then SIGKILL for anything still alive after ' +
            '`graceMs` (the same grace the subprocess service uses). Artifacts are only deleted once they are ' +
            'older than `stale_minutes`, unless `remove_build_database: true` asks for them regardless — that ' +
            'costs the next build its incremental state.',
        // It kills processes and deletes build state: never run it beside other tools.
        isConcurrencySafe: () => false,
        // SIGTERM, a grace wait, then SIGKILL plus three simctl calls.
        timeoutMs: config.graceMs + config.simctlTimeoutMs * 2 + 60000,
        parameters: {
            type: 'object',
            properties: {
                auto_clean: {
                    type: 'boolean',
                    description: 'Actually clean. Defaults to false, which only reports what would be removed — always worth ' +
                        'one report-only run first. Set it to true to terminate the leftovers, delete the artifacts ' +
                        'and shut the simulators down.',
                },
                cwd: {
                    type: 'string',
                    description: 'Directory whose workspace identifies "our" processes. Defaults to the plugin working directory.',
                },
                derived_data_path: {
                    type: 'string',
                    description: 'DerivedData to inspect for stale build state. Defaults to the configured `derivedDataPath` ' +
                        '(absolute, or relative to `cwd`).',
                },
                stale_minutes: {
                    type: 'number',
                    description: 'Only artifacts untouched for this many minutes are removable. Defaults to 30, clamped to ' +
                        '0–1440; 0 means "everything", so an in-flight build is protected by the default, not by luck.',
                },
                remove_build_database: {
                    type: 'boolean',
                    description: 'Remove the build database even when it is fresh. Defaults to false; true forces the next ' +
                        'build to recompile from scratch.',
                },
                kill_processes: { type: 'boolean', description: 'Defaults to true; set false to leave processes alone.' },
                shutdown_simulators: {
                    type: 'boolean',
                    description: 'Shut down every booted simulator. Defaults to true.',
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
                    autoClean: { type: 'boolean' },
                    processes: { type: 'array', items: { type: 'string' } },
                    terminated: { type: 'integer' },
                    forceKilled: { type: 'integer' },
                    survived: { type: 'array', items: { type: 'string' } },
                    artifacts: { type: 'array', items: { type: 'string' } },
                    foundArtifacts: { type: 'array', items: { type: 'string' } },
                    removedArtifacts: { type: 'array', items: { type: 'string' } },
                    bootedSimulators: { type: 'array', items: { type: 'string' } },
                    notes: { type: 'array', items: { type: 'string' } },
                },
            },
            render(_args, value) {
                const list = (input) => (Array.isArray(input) ? input.filter(isNonEmptyString) : []);
                const notes = list(value.notes);
                const section = (title, items, limit = 10) => items.length === 0
                    ? undefined
                    : `${title} (${items.length}):\n${items.slice(0, limit).map((item) => `- ${item}`).join('\n')}` +
                        (items.length > limit ? `\n- … ${items.length - limit} more` : '');
                const parts = [
                    value.summary,
                    section('Leftover processes', list(value.processes)),
                    section('Build-state artifacts found', list(value.foundArtifacts)),
                    section('Would remove', list(value.artifacts)),
                    section('Removed', list(value.removedArtifacts)),
                    section('Booted simulators', list(value.bootedSimulators)),
                    section('Still alive after SIGKILL', list(value.survived)),
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const autoClean = args.auto_clean === true;
            const notes = [];
            const call = (argv, timeoutMs) => runCommand(ctx, config, {
                argv,
                cwd,
                timeoutMs,
                ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            });
            const derivedDataRequested = isNonEmptyString(args.derived_data_path)
                ? args.derived_data_path.trim()
                : config.derivedDataPath;
            const derivedData = derivedDataRequested.length === 0
                ? undefined
                : isAbsolute(derivedDataRequested)
                    ? derivedDataRequested
                    : join(cwd, derivedDataRequested);
            const staleMinutes = positiveNumber(args.stale_minutes, 30, 0, 24 * 60);
            const staleBefore = Date.now() - staleMinutes * 60_000;
            /** `pgrep -fl xcodebuild` lines, or none when nothing matches (exit 1). */
            const listXcodebuild = async () => {
                const listed = await call(['/usr/bin/pgrep', '-fl', 'xcodebuild'], 15000);
                if (listed.unavailable) {
                    notes.push(`could not list processes: ${bounded(listed.output, 300).text}`);
                    return [];
                }
                // pgrep exits 1 when nothing matched, which is not an error.
                return listed.output
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0 && /^\d+\s/.test(line));
            };
            const pidsOf = (lines) => lines
                .map((line) => Number(line.split(/\s+/)[0]))
                .filter((pid) => Number.isInteger(pid) && pid > 0);
            // ---- 1. leftover build and simulator processes -------------------------
            const uuidPattern = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;
            /**
             * The process classes worth looking for, and how to tell ours from someone else's.
             *
             * Only `xcodebuild` names this workspace on its command line. The simulator-scoped
             * ones name a device instead, so their ownership is inferred from the UDID and
             * reported as inferred rather than pretended: a `log stream` or an `idb_companion`
             * left behind is exactly what wedges a simulator, and both respawn on demand.
             */
            const classes = [
                {
                    name: 'xcodebuild',
                    pattern: 'xcodebuild',
                    owns: (line) => line.includes(cwd) || (derivedData !== undefined && line.includes(derivedData)),
                },
                { name: 'simctl log stream', pattern: 'simctl.*log stream', owns: (line) => uuidPattern.test(line) },
                { name: 'idb_companion', pattern: 'idb_companion', owns: () => true },
            ];
            /** `pgrep -fl <pattern>` lines; an empty list also covers "nothing matched" (exit 1). */
            const listPattern = async (pattern) => {
                const listed = await call(['/usr/bin/pgrep', '-fl', pattern], 15000);
                if (listed.unavailable) {
                    notes.push(`could not list processes: ${bounded(listed.output, 300).text}`);
                    return [];
                }
                return listed.output
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0 && /^\d+\s/.test(line));
            };
            /** One sweep of every class; `foreign` keeps what belongs to somebody else. */
            const scan = async () => {
                const leftovers = [];
                const foreign = [];
                for (const klass of classes) {
                    for (const line of await listPattern(klass.pattern)) {
                        const pid = Number(line.split(/\s+/)[0]);
                        if (!Number.isInteger(pid) || pid <= 0)
                            continue;
                        if (klass.owns(line))
                            leftovers.push({ className: klass.name, line, pid });
                        else
                            foreign.push(`[${klass.name}] ${line}`);
                    }
                }
                return { leftovers, foreign };
            };
            const firstSweep = await scan();
            const leftovers = firstSweep.leftovers;
            const foreignXcodebuild = firstSweep.foreign.filter((line) => line.startsWith('[xcodebuild]')).length;
            if (foreignXcodebuild > 0) {
                notes.push(`${String(foreignXcodebuild)} other \`xcodebuild\` process(es) were left alone — their command ` +
                    'line does not name this workspace or its DerivedData');
            }
            const terminated = [];
            const survived = [];
            if (args.kill_processes !== false && autoClean && leftovers.length > 0) {
                const pids = [...new Set(leftovers.map((entry) => entry.pid))];
                await call(['/bin/kill', '-TERM', ...pids.map(String)], 15000);
                // The same grace the subprocess service gives a child between SIGTERM and
                // SIGKILL: long enough for xcodebuild to flush, short enough to not stall.
                await new Promise((resolve) => setTimeout(resolve, config.graceMs));
                const stillThere = new Set((await scan()).leftovers.map((entry) => entry.pid));
                const remaining = pids.filter((pid) => stillThere.has(pid));
                if (remaining.length > 0) {
                    await call(['/bin/kill', '-KILL', ...remaining.map(String)], 15000);
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
                const afterKill = new Set((await scan()).leftovers.map((entry) => entry.pid));
                for (const entry of leftovers) {
                    const labelled = `[${entry.className}] ${entry.line}`;
                    if (afterKill.has(entry.pid))
                        survived.push(labelled);
                    else
                        terminated.push(labelled);
                }
                notes.push(`sent SIGTERM to ${String(pids.length)} process(es) across ${String(classes.length)} classes, ` +
                    `then SIGKILL to ${String(remaining.length)} that were still alive after ${String(config.graceMs)} ms`);
            }
            else if (leftovers.length > 0) {
                notes.push(`found ${String(leftovers.length)} leftover process(es); nothing was signalled because ` +
                    (args.kill_processes === false ? '`kill_processes` is false' : '`auto_clean` is not true'));
            }
            // ---- 2. stale DerivedData build state ---------------------------------
            const artifacts = [];
            const walk = (dir, depth) => {
                if (depth > 5)
                    return;
                let entries;
                try {
                    entries = readdirSync(dir, { withFileTypes: true });
                }
                catch {
                    return;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (isLockArtifact(entry.name)) {
                        let mtimeMs = 0;
                        try {
                            mtimeMs = statSync(full).mtimeMs;
                        }
                        catch {
                            /* vanished between listing and stat */
                        }
                        artifacts.push({ path: full, kind: entry.isDirectory() ? 'dir' : 'file', mtimeMs });
                        // Never descend into a build database: its contents are not artifacts.
                        continue;
                    }
                    if (entry.isDirectory())
                        walk(full, depth + 1);
                }
            };
            if (derivedData !== undefined) {
                if (existsSync(derivedData))
                    walk(derivedData, 0);
                else
                    notes.push(`no DerivedData at ${derivedData}`);
            }
            else {
                notes.push('no `derivedDataPath` is configured, so build state was not inspected');
            }
            const stale = artifacts.filter((artifact) => artifact.mtimeMs <= staleBefore);
            const removable = args.remove_build_database === true ? artifacts : stale;
            const removedArtifacts = [];
            if (autoClean) {
                for (const artifact of removable) {
                    try {
                        rmSync(artifact.path, { recursive: artifact.kind === 'dir', force: true });
                        removedArtifacts.push(`${artifact.path} (${artifact.kind})`);
                    }
                    catch (error) {
                        notes.push(`could not remove ${artifact.path}: ${describeError(error)}`);
                    }
                }
            }
            // ---- 3. booted simulators ---------------------------------------------
            const bootedSimulators = [];
            const bootedResult = await call([config.xcrunPath, 'simctl', 'list', 'devices', 'booted', '-j'], config.simctlTimeoutMs);
            if (!bootedResult.unavailable && bootedResult.exitCode === 0) {
                const document = parseJsonObject(bootedResult.output);
                const devices = document?.devices;
                for (const list of Object.values(devices ?? {})) {
                    for (const device of Array.isArray(list) ? list : []) {
                        if (device.state !== 'Booted')
                            continue;
                        bootedSimulators.push(`${String(device.name ?? '(unnamed)')} (${String(device.udid ?? '?')})`);
                    }
                }
            }
            let shutdownDone = false;
            if (args.shutdown_simulators !== false && autoClean && bootedSimulators.length > 0) {
                const stopped = await call([config.xcrunPath, 'simctl', 'shutdown', 'all'], config.simctlTimeoutMs);
                shutdownDone = !stopped.unavailable && stopped.exitCode === 0;
                if (!shutdownDone)
                    notes.push(`\`simctl shutdown all\` failed: ${bounded(stopped.output, 300).text}`);
            }
            const found = `${String(leftovers.length)} leftover process(es) across ${String(classes.length)} classes ` +
                `(${classes.map((klass) => klass.name).join(', ')}), ` +
                `${String(removable.length)} removable build-state artifact(s) of ${String(artifacts.length)} found, ` +
                `${String(bootedSimulators.length)} booted simulator(s)`;
            return {
                ok: true,
                autoClean,
                summary: autoClean
                    ? `cleanup done: terminated ${String(terminated.length)}, force-killed ${String(survived.length)}, ` +
                        `removed ${String(removedArtifacts.length)} artifact(s), simulators shut down: ${shutdownDone ? 'yes' : 'no'}`
                    : `report only — found ${found}; re-run with \`auto_clean: true\` to clean, or keep this as the record`,
                processes: leftovers.map((entry) => `[${entry.className}] ${entry.line}`),
                terminated: terminated.length,
                forceKilled: survived.length,
                survived,
                artifacts: removable.map((artifact) => artifact.path),
                foundArtifacts: artifacts.map((artifact) => artifact.path),
                removedArtifacts,
                bootedSimulators,
                notes,
            };
        },
    });
    register({
        name: 'simulator_elements',
        description: 'List the booted simulator\'s accessibility elements with their identifiers and centres, read from ' +
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
            render(_args, value) {
                const notes = Array.isArray(value.notes) ? value.notes.filter(isNonEmptyString) : [];
                const parts = [
                    value.summary,
                    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : undefined,
                    value.elements,
                ].filter(isNonEmptyString);
                return [textBlock(parts.join('\n\n'))];
            },
        },
        async execute(args, exec) {
            const cwd = resolveCwd(config, args.cwd);
            const notes = [];
            const resolved = await resolveDevice(ctx, config, cwd, args.device, exec.signal);
            if (resolved.udid === undefined) {
                return {
                    ok: false,
                    summary: messageOr(resolved.note, 'no booted simulator; boot one with simulator_control first'),
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
            const matching = query === undefined
                ? all
                : all.filter((element) => element.label.toLowerCase().includes(query) || element.uniqueId.toLowerCase().includes(query));
            const limit = Math.floor(positiveNumber(args.max_elements, 60, 1, 400));
            const shown = matching.slice(0, limit);
            if (all.length === 0) {
                notes.push('the accessibility tree was empty; the screen may be showing a system UI or nothing focusable');
            }
            else if (shown.length < matching.length) {
                notes.push(`showing ${shown.length} of ${matching.length} matching elements`);
            }
            const rendered = shown.map(formatAccessibilityElement).join('\n');
            const boundedText = boundedTail(rendered, config.maxOutputChars);
            if (boundedText.truncated) {
                notes.push(`the list was trimmed to the last ${config.maxOutputChars} characters`);
            }
            return {
                ok: true,
                summary: `read ${all.length} element(s) from ${udid}` +
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
        disposers.push(ctx.systemPrompt.section({
            name: 'ios-dev-helper/swiftui',
            order,
            // Drop the section entirely when this plugin's tools are hidden from the
            // viewing scope, so prompt and tool surface never disagree.
            text: ({ scope }) => ctx.tools.get('xcode_build', scope) === undefined ? '' : SWIFTUI_GUIDANCE,
        }));
    }
    // Cordis disposes effect-owned registrations on unload; returning the same
    // cleanup keeps teardown explicit and idempotent.
    return () => {
        for (const dispose of disposers.splice(0).reverse()) {
            try {
                dispose();
            }
            catch {
                // A registration already removed by scope teardown must not break unload.
            }
        }
    };
}
