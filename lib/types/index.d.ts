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
/** Build the plugin. */
export declare function apply(ctx: Ctx, rawConfig?: unknown): () => void;
export {};
