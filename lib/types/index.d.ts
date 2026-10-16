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
/** Services this plugin needs. The plugin stays inactive without them. */
export declare const inject: string[];
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
                stdin: 'ignore' | 'pipe' | {
                    data: string;
                };
                stdout: 'pipe' | 'inherit' | {
                    maxBytes: number;
                    spill?: {
                        maxBytes: number;
                    };
                };
                stderr: 'pipe' | 'inherit' | {
                    maxBytes: number;
                    spill?: {
                        maxBytes: number;
                    };
                };
                control?: 'pipe';
            };
            graceMs: number;
            signal?: AbortSignal;
            env?: Record<string, string | undefined>;
        }): {
            collected: {
                stdout?: {
                    readFrom(fromByte: number): OutputRead;
                };
                stderr?: {
                    readFrom(fromByte: number): OutputRead;
                };
            };
            done: Promise<{
                exitCode: number | null;
                signal: string | null;
            }>;
            terminate(): void;
            waitForExit(signal?: AbortSignal): Promise<boolean>;
        };
    };
    systemPrompt: {
        section(section: {
            name: string;
            order: number;
            text: string | ((context: {
                scope?: object;
            }) => string);
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
/**
 * Discover the workspace/project, schemes, and default scheme in one directory.
 * @param ctx Plugin context carrying the `subprocess` service.
 * @param config Resolved plugin configuration.
 * @param cwd Directory to look for an `.xcworkspace`/`.xcodeproj` in.
 * @returns The chosen target, its schemes, any tool-level diagnostic, and a log line when nothing was found.
 */
/** Everything `buildXcodeInvocation` needs; `target` and `scheme` are already resolved. */
interface XcodeInvocationInput {
    args: Record<string, unknown>;
    config: HelperConfig;
    cwd: string;
    action: string;
    target: string;
    scheme: string | undefined;
}
/** An assembled `xcodebuild` command line, or the reason it could not be assembled. */
type XcodeInvocation = {
    argv: string[];
    notes: string[];
    destination?: string;
    derivedDataPath?: string;
} | {
    error: string;
};
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
export declare function buildXcodeInvocation(input: XcodeInvocationInput): XcodeInvocation;
/** Build the plugin. */
export declare function apply(ctx: Ctx, rawConfig?: unknown): () => void;
export {};
