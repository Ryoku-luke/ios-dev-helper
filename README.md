# ios-dev-helper

A DeepSeek Harness **Host plugin** that gives the Agent three iOS development
capabilities, plus project-appropriate SwiftUI guidance.

| Capability | Tools |
|---|---|
| Xcode build | `xcode_build`, `xcode_info`, `ios_dependencies` |
| Simulator control | `simulator_control`, `simulator_install_launch`, `simulator_screenshot`, `simulator_logs`, `simulator_tap`, `simulator_elements` |
| SwiftUI / HIG guidance | the `ios-dev-helper/swiftui` system-prompt section (not a tool) |

Every external process goes through the harness `subprocess` Service
(`ctx.subprocess`), so children inherit the harness's own authority, are subject
to its SIGTERM→SIGKILL grace ladder, and are joined at composition teardown.
The plugin imports **no** npm packages — only the Node built-ins `node:fs` and
`node:path` — and never `node:child_process`, so it can never fail on package
resolution. Its only non-required service is `attachments`, reached through
`ctx.get`, so a profile without it still activates and keeps the path behaviour.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Plugin source — the file to edit. |
| `lib/index.js` | Built entry point. **This is what DSH loads.** |
| `lib/types/index.d.ts` | Generated declarations. |
| `tsconfig.json` | Build configuration. |
| `package.json` | Manifest; `dsh.bundle.patch` marks this package as a bundle. |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row. |

## Why there is a build step

Node refuses to strip TypeScript types for any module whose real path is under a
`node_modules` directory (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and
`install_bundle` links this package into the profile's `node_modules`. A `.ts`
entry point therefore cannot activate as an installed plugin. `package.json`
points at the built `lib/index.js` for that reason — `src/index.ts` stays the
authored source.

Rebuild after editing `src/`:

```sh
npm install        # once: installs the dev-only TypeScript toolchain
npm run build      # tsc -p tsconfig.json  ->  lib/index.js + lib/types/
```

`typescript` and `@types/node` are `devDependencies`; nothing at runtime needs
them, so the installed plugin stays dependency-free.

## Tests

```sh
npm test           # compiles, then runs node --test test/*.test.mjs
```

The suite needs no test framework and no network: it drives the plugin against a
stubbed `subprocess` service (`test/support/harness.mjs`) and asserts what the
tools actually ask the outside world to do.

- `test/xcode-invocation.test.mjs` unit-tests the pure `buildXcodeInvocation`,
  which is why that function is exported: the exact argument vector, the
  DerivedData precedence and the `onlyTesting` validation are asserted directly,
  with no process and no stub.
- `test/xcode-build.test.mjs` covers the tool: the target preflight, diagnostic
  capping and counting, the write-permission cause, budget outcomes and truncation
  safety.
- `test/simulator-tools.test.mjs` covers simulator input validation, the install
  retry/timeout policy, and that host cancellation reaches every spawned command.

`pnpm test` runs the same thing, and CI runs it after the build.

### Real-environment integration test

`test/integration.test.mjs` is opt-in and skipped by default (CI has no Xcode or
simulator). It builds a real workspace with `xcodebuild`, installs and launches the
product on a real simulator, and — the check that matters — **cross-checks the plugin's
diagnostic counts against the raw log it was shown**, which is how a parser that drops
a real warning gets caught instead of reporting a clean run.

```sh
IOS_HELPER_INTEGRATION=1 \
IOS_HELPER_INTEGRATION_ROOT=/path/to/project \
IOS_HELPER_INTEGRATION_SIMULATOR='iPhone 17 Pro' \
IOS_HELPER_INTEGRATION_BUNDLE_ID=com.example.app \
  node --test test/integration.test.mjs
```

It supplies its own real `subprocess` implementation (`test/support/real-subprocess.mjs`),
since a standalone Node process cannot borrow the harness's service.

## Which version is loaded?

The version from `package.json` is stamped into **every tool description** (as a
trailing `[ios-dev-helper vX.Y.Z]`) and into the guidance heading. That matters
because a Host keeps serving the module it imported at startup: a plugin whose
`lib/index.js` was rebuilt on disk looks identical to one that was actually
reloaded, so without a stamp the two are indistinguishable from the outside —
which is exactly how a stale Host once had to be identified, by diffing a parameter
description by hand.

To check what is live, read any tool's description (for example through the Tool
inspect provider, or in the tool list the model sees) and compare it with
`package.json`. If they differ, the Host predates your change: restart DSH, since a
host-side plugin module is cached for the process lifetime (`dsh-hmr` does not
cover a `link:` dependency).

## Tools

### `xcode_build`

Runs `xcodebuild` and parses its diagnostics into bullets: `error`/`warning`
lines that carry a position become `file:line:col: severity: message`, and
`xcodebuild`-level failures with no position (a missing scheme, an unmatched
destination) become `<producer>: severity: message`.

Severity matching is **case-insensitive** on purpose. The compilers write lowercase
`error:`/`warning:`, but `xcodebuild` writes its own diagnostics in upper case —
`--- xcodebuild: WARNING: Using the first of multiple matching destinations:` — and
matching only lowercase silently reported a run it had warned about as
`0 warning(s)`, which `treatWarningsAsErrors` then passed as clean.

- Auto-discovers the `.xcworkspace`/`.xcodeproj` and the scheme in the working
  directory. With several schemes it picks the one named after the project or
  workspace (Xcode's own convention for the app target) and says so in the
  notes; pass `scheme` to build a different one.
- An **explicit `target` is checked before anything is spawned**: a path that does
  not exist fails immediately, naming the candidates that *are* in the directory,
  instead of paying for a full `xcodebuild` start that reports a bare
  "does not exist".
- `configuration` is appended as `-configuration <value>` when supplied. When it is
  omitted, xcodebuild uses the scheme's own build configuration rather than this
  tool forcing one. (Until 2026-10-16 the value was accepted and then never used, so
  `configuration: "Release"` silently built Debug.)
- Failure causes that the raw output leaves unexplained are translated: a
  write-permission signature (`Operation not permitted`, `… is not writable`)
  becomes a summary clause and a note saying which paths and permissions to check.
- `action`: `build` (default), `test`, `clean`, `build-for-testing`,
  `test-without-building`.
- `onlyTesting` narrows a test action to specific identifiers, each appended as
  the **joined** `-only-testing:<id>` form that this repository's
  `Tools/run_tests.sh` uses. (xcodebuild accepts `-only-testing <id>` too: a
  control run shows both parse, while an unknown flag fails with
  `invalid option`.) Identifiers take the form
  `TestTarget[/TestClass[/TestMethod]]`, e.g. `["LunisolarCalendarUITests"]` or
  `["LunisolarCalendarUITests/CalendarUITests/testLaunch"]`; the array is trimmed
  and deduplicated.
  - Validation runs **before** anything is spawned: a non-array, an empty array,
    or an entry that is not a non-empty string fails the call with a message
    naming the problem, and no `xcodebuild` process is started.
  - The earlier `only_testing` spelling still works as a hidden alias, but is no
    longer advertised in the schema.
  - On a non-test action the flag is ignored by `xcodebuild`, so the tool adds a
    note saying so rather than implying the run was filtered.
- Composes a `-destination` from `simulator` + `os` when `destination` is
  omitted, e.g. `simulator: "iPhone 17 Pro"`, `os: "26.5"`. A destination you ask
  for (or a named `simulator`) is honoured for **every** action, including `clean`
  and `build-for-testing`, which otherwise run with none — and then `xcodebuild`
  guesses a destination, says so itself, and can clean another destination's products.
- Marks the build not-ok when `warningCount > 0` **and** `treatWarningsAsErrors`
  is on, mirroring this repository's `Tools/run_tests.sh` rule that compiler
  warnings are failures.
- **Three failures in a row and the result recommends a cleanup.** `xcode_build` counts
  consecutive failures per working directory and appends a final block to the result,
  "检测到连续失败 N 次，建议调用 cleanup_environment 清理缓存" — because a project that
  built a minute ago and now will not is usually a leftover `xcodebuild` or a wedged
  DerivedData database rather than a code problem. A successful build clears the streak,
  and the counter lives with the plugin instance (a reload resets it).
- **A test run that executes no test is a failure, not a pass.** `xcodebuild`
  exits 0 and prints `** TEST SUCCEEDED **` even when a filter matched nothing
  (`Executed 0 tests`), so the tool reads the `Executed N test(s)` count and
  reports `ok: false` with `xcodebuild test ran no tests`, plus a note telling the
  caller to check the spelling. The count is returned as `executedTests` for
  every test action and mentioned in the notes. Verified against this repository:
  a method-level identifier ran exactly one test and passed, the same command with
  a misspelled method ran zero and is now reported as a failure.
  (`build-for-testing` only builds, so the guard does not apply to it.)
- `shutdown_simulators` (default `false`) guards the trap this repository's
  `Tools/run_tests.sh` documents: a UI channel run against leftover simulator
  state produces **random single-test failures that read as business bugs**. For
  a test action the tool always checks for booted simulators and either shuts
  them all down first (`shutdown_simulators: true` → `xcrun simctl shutdown all`)
  or warns, naming the devices. Measured here: the identical channel command
  reported `ok: false` with 2 assertion failures on a dirty simulator, and
  `ok: true` with 13 passed / 3 skipped after `simctl shutdown all`.
  Non-test actions (`build`, `clean`, `build-for-testing`) issue no extra
  `simctl` call and never shut anything down.
- Runs with `isConcurrencySafe: () => false`: parallel `xcodebuild` runs
  interfere through the shared simulator and DerivedData.

### `xcode_info`

Reports the discovered target, its schemes, and the available simulator
runtimes. Call it before a first `xcode_build` when the scheme is unknown.

### `ios_dependencies`

Resolves a project's dependencies before a first build, by detecting manifests in
the working directory (the configured `workspaceRoot`, i.e. the repository root)
rather than taking a flag — whichever a project uses is already on disk:

| Detected | Command |
| --- | --- |
| `Podfile` | `pod install` |
| `Package.swift` | `swift package resolve` |

Both run, in that order, when both exist (a project may carry a Podfile *and* a
local SwiftPM package). Neither existing is a failure, with a message naming the
directory and pointing at `cwd`.

- Per-command budget: `dependenciesTimeoutMs` (default 300000, i.e. 5 minutes),
  overridable per call with `timeout_ms` (clamped to 1000–3600000). A timeout is
  reported as a failure and named in the notes.
- A missing CLI is reported, never silently skipped. Measured on this machine:
  `pod` is **not installed**, so a `Podfile` yields
  `ok: false` with
  ``CocoaPods: `pod` could not be launched — it is not installed or not on PATH``
  and the result's own output explains that the process never started. This
  needed a fix in `runCommand`: a process that never launched reports no exit
  status, which previously produced a bare "failed in 0s" with empty output.
- `swiftPath`/`podPath` (config) resolve `~` and exist because these CLIs are
  often installed outside the default `PATH` (rbenv, a toolchain manager).
- Verified against this repository: `Package.swift` (no remote dependencies) →
  `swift package resolve` in ~1s, `ok: true`, and **nothing added to the repo**
  (no `Package.resolved`, since there is nothing to resolve).

### `simulator_control`

`action`: `list`, `boot`, `shutdown`, `booted`, `open`, `erase`, `delete`,
`runtime_list`. `device` accepts a name, a UDID, or `booted`. `erase` and
`delete` require `confirm: true`; `boot` on an already-booted device is treated
as success rather than an error.

### `simulator_install_launch`

Installs a built `.app` on a simulator and optionally launches it.
`bundle_id` is required to launch and optional when only installing.

- The install budget is `simctlTimeoutMs` (default 2 minutes), because a large
  `.app` has to be copied into the device container. Both the install and the
  launch report how long they took, so a slow bundle is visible rather than
  guessed at.
- **One retry on infrastructure flake only.** A failed install is retried once
  (after a 1s pause) when its output matches `FLAKY_SIMCTL_PATTERN` — the same
  signals this repository's `Tools/run_tests.sh:50` treats as retryable. A real
  failure (a missing bundle, no space left) is never retried, mirroring the
  project's rule that genuine failures are reported, not retried.
- **Timeouts are named, not silently swallowed.** A budget-stopped install reads
  `install timed out after N ms (…)`, a stopped launch reads
  `launch timed out after N ms`, and each adds a note pointing at
  `simctlTimeoutMs`. An operation that merely *crossed* the budget but finished on
  its own is reported as success with a note, never as a timeout it did not have.
- The tool's declared ceiling is `simctlTimeoutMs × 7 + 30s`: boot (1×) + install
  with its retry (2×) + launch (4× when `--console-pty` streams until the app
  exits). Declaring less would let the harness cancel a call that is still
  legitimately working.

### `simulator_screenshot`

Captures the booted simulator's screen with
`xcrun simctl io <device> screenshot <file>` and returns the **absolute path** of
the PNG, so it can be inspected with the `read_image` tool.

- Without `path`, the file is written to
  `<cwd>/<screenshotDir>/screenshot-<UTC timestamp>.png` (the directory is created
  on demand). An explicit `path` — absolute, or relative to `cwd` — overrides it.
- `device` accepts a name, a UDID, or `booted` (the default).
- **The capture is attached to the conversation** as an `ImageBlock` through the
  optional `attachments` service, so the model sees the picture without a second
  `read_image` call. Pass `attach: false` to skip that. Without the service, or if
  the store refuses the image, the tool still succeeds and reports the path plus a
  note explaining why nothing was attached.
- A zero exit code is not trusted on its own: the tool stats the file and reports
  failure if no readable image landed, and it says so plainly when no simulator is
  booted.

### `ios_verify_ui`

Checks the screen against a plain-language acceptance criterion, e.g.
`"屏幕上应该出现日历和日期选择器"`.

**A tool cannot see**, so this is deliberately a two-phase protocol rather than one
magic call:

1. **Phase 1** — call it with `acceptance_criteria` only. It captures the screen
   (`<cwd>/<screenshotDir>/verify-<UTC timestamp>.png`, attached as an `ImageBlock`
   like `simulator_screenshot` does) and returns the criterion, the path and
   instructions telling the vision-capable model to judge it. It never invents a
   verdict.
2. **Phase 2** — call it again with the same `acceptance_criteria` plus `passed`
   (and, when it failed, `reason`). The answer is `{ passed: true }`, or
   `{ passed: false, reason, nextSteps }` with concrete remediation: inspect what is
   actually on screen with `simulator_elements`, re-capture if the frame was
   mid-animation, and — when the UI is genuinely missing — fix the SwiftUI code, then
   `xcode_build`, `simulator_install_launch` and verify again.

`ok` is false whenever the criterion is **not met** or the check could not run;
`status` disambiguates (`failed`, `capture-failed`, `no-device`,
`invalid-arguments`, or `awaiting_vision_judgement` in phase 1). A `passed: false`
without a `reason` is refused: an unexplained failure cannot be fixed, and cannot be
audited later.

**Why not one call that returns the verdict?** Doing that would mean the plugin
answering with its own model call (`ctx.get('llm')` → `prepareCall` → `stream`, checking
`inputModalities` for `image`). That is possible, but it spends another billed,
credentialed request per verification to duplicate a judgement the calling model is
already making — and it silently changes whose opinion the verdict is. Say the word if
you want that variant.

### `cleanup_environment`

Recovers the machine after an interrupted run — a cancelled build, a crashed Xcode, a
simulator left behind. Three steps, all reported:

1. **Leftover `xcodebuild` processes.** `pgrep -fl xcodebuild` is filtered to the ones
   whose command line names **this** workspace or its DerivedData; anything else is
   left alone and reported as such, so a build you started yourself in Xcode survives.
   Termination is `SIGTERM`, then — after `graceMs`, the same grace the subprocess
   service gives a child — `SIGKILL` for anything still alive, which is then reported
   under `survived` rather than quietly called cleaned.
2. **Stale DerivedData build state.** The walk looks for the artifacts Xcode actually
   leaves behind (measured on a real DerivedData: `Build/Intermediates.noindex/
   XCBuildData/build.db` plus a `<hash>.xcbuilddata` directory) together with
   `*.lock`/`*.lockfile`, and deletes only what has been untouched for
   `stale_minutes` (default 30) — so an in-flight build's database is protected by the
   rule, not by luck. `remove_build_database: true` takes them regardless, at the cost
   of the next build's incremental state.
3. **Booted simulators.** `simctl shutdown all`, with the devices that were booted
   reported first.

**It only reports unless `auto_clean: true`.** Run it once without it to see what would
be done; that report is also the record of what was left behind.

### `simulator_logs`

Listens to the booted simulator's unified log with
`xcrun simctl spawn <device> log stream --level=debug` and reports the `error`
and `fault` entries, newest last.

- The stream never ends on its own, so it is stopped after `seconds` (default 5,
  clamped to 1–60). Measured precision on this project's simulator: ~5136 ms for
  a 5 s window.
- **The `error`/`fault` selection happens inside `log`**, not after the fact:
  `log stream` is given a `--predicate` for the Error (logType 16) and Fault
  (logType 17) message types, plus `--style=ndjson` for machine-parsable records.
  An unfiltered `--level=debug` window emits ~600 KB per 5 s; the same window with
  the predicate yields a handful of lines.
- `max_lines` (default 200, clamped to 1–2000) keeps the **newest** matching
  entries. The rendered text is then bounded by `maxOutputChars`, and a single
  runaway message is cut at 400 characters, so context stays small. Measured: a
  513-line / 620 KB capture reduced to 572 bytes of `error`/`fault` text.
- A stream that exits *by itself* with a nonzero status (a bad predicate, no such
  device) is a failure; a window that ended because the tool stopped it is not.

### `simulator_tap`

Taps the booted simulator, either at an absolute point (`x`, `y`) or on the
element that owns an `accessibility_id`.

**`xcrun simctl` has no tap command.** Its `io` operation only offers
`enumerate`, `poll`, `recordVideo`, `screenshot` and `screenConfig`, and
`xcrun simctl io booted tap x y` exits 117 with a usage error. Touch injection
therefore goes through **`idb`** (`idb ui tap`), which is the only supported
route — see [Installing idb](#installing-idb).

- Coordinates are **points**, not pixels: the logical screen, e.g. `402x874` for
  an iPhone 17 Pro, not the `1206x2622` screenshot raster.
- With `accessibility_id`, the tool reads the tree with
  `idb ui describe-all` and taps the matched element's frame centre. Matching is
  exact `AXUniqueId`, then exact label, then case-insensitive, then substring;
  among ties the smallest frame wins. `Application` nodes are never matched —
  `describe-all` always reports the foreground app as a full-screen element named
  after itself, so matching it would tap the middle of the screen.
- Identifiers are discovered with `simulator_elements`; a failed lookup returns
  the first candidates so the caller can retry without a second call.
- **Tap and look in one call.** By default the tool waits `settle_ms` (default
  700, clamped to 0–10000) for the animation, captures the screen, and attaches
  the PNG as an `ImageBlock`, so the outcome is visible without a second
  `simulator_screenshot` call. Pass `screenshot: false` to only tap. A capture
  that fails does not fail the tap: the result stays `ok` with a note.
- Companion recovery: if `idb` cannot reach a companion because its domain socket
  is gone (a Host restart that reaped it, a reboot, a manual `kill`), the tool
  removes the unreachable record from `/tmp/idb/state` — the registry `idb`
  hardcodes and does not clean up itself — and retries once, saying so in the
  notes. Only records whose socket file is provably missing are removed, so a live
  companion is never disturbed.

### `simulator_elements`

Lists the accessibility elements with their identifiers and tap centres, read
from `idb ui describe-all`. `query` filters case-insensitively on label or
identifier, and `max_elements` (default 60) bounds the list. This is the
discovery half of `simulator_tap`'s `accessibility_id` mode.

## Installing idb

`simulator_tap` and `simulator_elements` need the [fb-idb](https://github.com/facebook/idb)
client plus its `idb_companion` daemon. The layout this README assumes:

```
~/.dsh/tools/idb/
├── bin/idb            # wrapper: puts ./companion on PATH, execs venv/bin/idb
├── bin/uv             # the toolchain installer used below
├── companion/         # idb_companion (prebuilt, macos-arm64)
├── python/            # user-space CPython 3.12 (python-build-standalone)
└── venv/              # fb-idb 1.6.5
```

Built without Homebrew, without sudo, and without touching the system Python:

```sh
# 1. idb_companion (verify the sha256 against the GitHub release API digest)
curl -L -o companion.tgz \
  https://github.com/facebook/idb/releases/download/v1.6.5/idb-companion.macos-arm64.tar.gz
mkdir -p ~/.dsh/tools/idb/companion && tar -xzf companion.tgz -C ~/.dsh/tools/idb/companion

# 2. user-space CPython 3.12 (fb-idb requires >=3.10; macOS ships 3.9)
curl -L -o py.tgz \
  'https://github.com/astral-sh/python-build-standalone/releases/download/20261001/cpython-3.12.15%2B20261001-aarch64-apple-darwin-install_only.tar.gz'
mkdir -p ~/.dsh/tools/idb/python && tar -xzf py.tgz -C ~/.dsh/tools/idb/python --strip-components=1

# 3. the client, pinned to the companion's version
~/.dsh/tools/idb/python/bin/python3.12 -m venv ~/.dsh/tools/idb/venv
~/.dsh/tools/idb/venv/bin/pip install 'fb-idb==1.6.5'

# 4. a wrapper so the companion is discoverable
printf '#!/bin/sh\nDIR="$(cd "$(dirname "$0")/.." && pwd)"\nPATH="$DIR/companion:$PATH"\nexport PATH\nexec "$DIR/venv/bin/idb" "$@"\n' \
  > ~/.dsh/tools/idb/bin/idb && chmod +x ~/.dsh/tools/idb/bin/idb

# 5. verify
~/.dsh/tools/idb/bin/idb ui describe-all --udid "$(xcrun simctl list devices booted -j \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next(iter(d.values()))[0]["udid"])')" | head -c 200
```

Two notes learned while setting this up:

- The client and companion must be the **same version family**: fb-idb 1.1.7
  against idb_companion 1.6.5 fails with `IdbJsonException: Failed to parse json
  from:` during the companion handshake. Use `fb-idb==1.6.5`.
- `idb_companion` writes into
  `~/Library/Developer/CoreSimulator/Devices/<UDID>/data/fbsimulatorcontrol/`.
  A process confined by the DSH *file* sandbox (such as the `bash` tool) cannot,
  and fails with `Failed to create xctest storage location` — the plugin's own
  subprocesses are not confined, so the tools work where a sandboxed shell does
  not.

Passing the path explicitly keeps the plugin portable:

```yaml
config:
  idbPath: ~/.dsh/tools/idb/bin/idb   # a leading ~ is expanded by the plugin
```

## Configuration

Values come from the `config:` block in `cordis.patch.yml` and are validated by
the plugin at activation (there is no `Config` export, so no schemastery
dependency). An unknown key is ignored; an absent key keeps its default.

| Key | Default | Meaning |
|---|---|---|
| `workspaceRoot` | `''` (use the Agent's cwd) | Pin builds to one checkout. |
| `xcodebuildPath` | `xcodebuild` | Absolute path or PATH name. |
| `xcrunPath` | `xcrun` | Absolute path or PATH name. |
| `derivedDataPath` | `.dsh/DerivedData` | Where `xcodebuild` keeps intermediate products, so repeat builds stay incremental. A relative value resolves against the build's working directory, and the result is **always** passed as `-derivedDataPath <path>`. Precedence: the per-call `derived_data_path` argument, then this config key, then the default. Applying it costs one full rebuild the first time a workspace switches location (`xcodebuild` creates the directory). |
| `screenshotDir` | `.dsh/screenshots` | Where `simulator_screenshot` writes when no explicit `path` is given; relative to the build's working directory. |
| `idbPath` | `idb` (PATH lookup) | The `idb` CLI used by `simulator_tap` and `simulator_elements`. A leading `~` expands to the home directory. Set it to `~/.dsh/tools/idb/bin/idb` for the layout above. |
| `idbTimeoutMs` | `120000` | Budget for one `idb` call; the first one in a session also starts the companion daemon. |
| `podPath` | `pod` (PATH lookup) | The CocoaPods CLI used by `ios_dependencies`. A leading `~` expands to the home directory. |
| `swiftPath` | `swift` (PATH lookup) | The SwiftPM CLI used by `ios_dependencies`. The Xcode toolchain's `swift` shim (`/usr/bin/swift`) works. |
| `dependenciesTimeoutMs` | `300000` | Budget for one `pod install` / `swift package resolve`; 5 minutes, because a cold `pod install` downloads pods. |
| `buildTimeoutMs` | `900000` | Budget for one `xcodebuild`. |
| `simctlTimeoutMs` | `120000` | Budget for one `simctl` call. |
| `maxOutputBytes` | `8388608` | Per-stream collector budget. |
| `maxDiagnostics` | `40` | Cap on the **error/warning** diagnostic bullets surfaced to the model; `note` lines are never surfaced. The cap limits bullets only — the summary counts every diagnostic, and an omission note reports how many were left out. |
| `maxOutputChars` | `6000` | Raw output tail surfaced to the model. |
| `graceMs` | `3000` | SIGTERM→SIGKILL grace. |
| `injectSwiftUIGuidance` | `true` | Register the prompt section. |
| `treatWarningsAsErrors` | `true` | Warning-only build counts as failed. |

## Install

```sh
# from the profile, or with plugin_manager action: install_bundle
dsh plugin --profile "$DSH_PROFILE" install /path/to/Tools/ios-dev-helper
```

## Notes and limits

- **Cancellation reaches the child**: the host's abort signal is forwarded to every
  spawned command (or, for the simulator tools, `process.terminate()`), so cancelling a
  tool call terminates what it started instead of leaving a build, install or `log stream`
  running — and `runCommand` now waits for the process range to be really quiescent on
  that path too, not only on a timeout, so a cancelled `xcodebuild` cannot leave compiler
  children holding the build database after the tool has answered. If that quiescence
  cannot be proven within `graceMs + 2000` ms, the result says so instead of pretending. A tool that has already been
  cancelled may still spawn follow-up commands; those arrive pre-aborted and are
  killed immediately, and `simulator_install_launch` never retries after a cancel.
- **Sandbox**: these tools spawn processes with the harness process's own
  authority. They are not confined by the DSH *file* sandbox that governs the
  `bash` tool, so `xcodebuild` can reach `~/Library/Caches` and DerivedData. The
  subprocess service does scrub credential-shaped environment names
  (`*KEY*`, `*PASSWORD*`, `*SECRET*`, `*TOKEN*`) and all `DSH_*` names from the
  child environment.
- **Screenshots live in the workspace**: `.dsh/screenshots/` (and the default
  `derivedDataPath`, `.dsh/DerivedData`) sit inside the repository, so `.dsh/`
  belongs in `.gitignore`. The deployment's image limits (20 MB per image,
  8192 px per side, 64 Mpx decoded by default) apply to attachment; a larger
  capture still lands on disk, it just is not attached inline.
- **Diagnostics, not raw logs**: the diagnostic bullets carry only `error` and
  `warning`; `note` lines (input encodings, dependency-order chatter) are dropped
  so a clean build does not look alarming. The raw log is bounded to the **last**
  `maxOutputChars` characters, because a build log puts its verdict at the end;
  raise that key when you need more of it.
  - The SwiftPM/sandbox-cache whitelist from `Tools/run_tests.sh`
    (`org.swift.swiftpm`, `not writable`, `readonly database`) filters **warnings
    only**, matching how that script applies it. Until 2026-10-16 this plugin applied
    it to every severity, which silently swallowed genuine `error:` lines — a
    permission failure saying "… is not writable" among them.
- `simulator_control` deliberately exposes no `spawn` action; arbitrary process
  execution stays with `bash`.
