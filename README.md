# ios-dev-helper

[![Version](https://img.shields.io/badge/version-1.0.6-blue.svg)](https://github.com/Ryoku-luke/ios-dev-helper/releases)
[![CI](https://github.com/Ryoku-luke/ios-dev-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/Ryoku-luke/ios-dev-helper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/Ryoku-luke/ios-dev-helper/blob/main/package.json)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#-架构与限制)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-54%20hermetic%20%2B%203%20integration-blue.svg)](https://github.com/Ryoku-luke/ios-dev-helper/blob/main/test)

> **TL;DR** — 给 DeepSeek Harness 的 iOS 开发插件：一条命令完成 **Xcode 构建 → 诊断解析 → 装进模拟器 → 启动 → 截图/点按 → 按验收标准判定 UI**。
> 12 个工具覆盖构建、模拟器、UI 自动化与验证、环境善后；构建错误会被翻成 `file:line:col: severity: message`，**警告也算失败**（可关）。
> 折叠屏 `iPhone Duo` 双面板识别（`LCD` / `LCD-1`）、按面板分屏截图、连续失败自动建议清理缓存。
> **零运行时依赖**：只用 Node 内置模块，全部外部进程走 Harness 的 `subprocess` 服务，天然受 SIGTERM→SIGKILL 宽限与取消传播约束。

这是一个 DeepSeek Harness 的 **Host 插件**，为 Agent 提供四类能力，外加贴合项目的 SwiftUI/HIG 提示词段落：

| 能力 | 工具 |
|---|---|
| 构建 | `xcode_build`、`xcode_info`、`ios_dependencies` |
| 模拟器 | `simulator_control`、`simulator_install_launch`、`simulator_screenshot`、`simulator_logs` |
| UI 自动化 | `simulator_tap`、`simulator_elements` |
| UI 验证 | `ios_verify_ui`、`duo_fold_state` |
| 环境 | `cleanup_environment` |
| SwiftUI / HIG 指引 | `ios-dev-helper/swiftui` 系统提示段（不是工具） |

所有外部进程统一经 Harness 的 `subprocess` 服务（`ctx.subprocess`）拉起：子进程继承 Harness 自身权限、受其 SIGTERM→SIGKILL 宽限阶梯约束、在组合销毁时被 join。插件**不引入任何 npm 包**（仅 `node:fs`、`node:path`、`node:zlib` 等内置模块），也从不直接使用 `node:child_process`，因此不会因依赖解析而失败。唯一的非必需服务是 `attachments`，通过 `ctx.get` 获取，缺失时插件照常激活、退化为只返回路径。

## 目录

- [✨ 核心特性](#-核心特性)
- [🚀 快速开始](#-快速开始)
- [🔌 可选依赖：安装 idb](#-可选依赖安装-idb)
- [🧰 工具全景](#-工具全景)
- [🔬 深度技术指南](#-深度技术指南)
- [🧱 架构与限制](#-架构与限制)

## ✨ 核心特性

- 🧠 **构建诊断，而不是原始日志** — `xcode_build` 把输出解析成 `file:line:col: severity: message` 条目；`error`/`warning` 匹配**大小写不敏感**（xcodebuild 自己的诊断是大写的 `--- xcodebuild: WARNING: …`），`note` 一律丢弃。警告条数可触发失败（`treatWarningsAsErrors`，默认开），lint 式门禁直接内建。
- 📱 **模拟器全流程自动化** — 启动/关闭/擦除、安装并启动 `.app`（瞬时故障只重试一次、超时明确报出、报告耗时）、统一日志窗口只回 `error`/`fault`、截图并**自动附图**给模型。
- 🖱️ **可点按、可断言的 UI 验证** — `simulator_tap` 支持坐标或 `accessibility_id`（点完顺手截图）；`simulator_elements` 导出无障碍树供定位；`ios_verify_ui` 用「验收标准 + 两阶段协议」把「屏幕上应该有日历和日期选择器」这类判断变成 `{ passed: true }` 或 `{ passed: false, reason, nextSteps }`。
- 📐 **折叠屏（iPhone Duo）原生支持** — 按设备类型寻址（`iPhone-Duo` / `com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`），枚举 `LCD` / `LCD-1` 双面板，**按像素**判断哪块在显示内容（纯黑面板仍有 ~106 KB，靠文件大小会判错），支持 `--display=LCD-1` 分屏截图。
- 🧹 **环境善后，且不误伤** — `cleanup_environment` 清理残留 `xcodebuild` / `simctl … log stream` / `idb_companion`（SIGTERM → 宽限 → SIGKILL，并如实报告幸存者）、清除超过 `stale_minutes` 的 DerivedData 构建态、关闭已启动的模拟器；**默认只报告**，只有 `auto_clean: true` 才动手。

## 🚀 快速开始

### 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | macOS（Apple Silicon 或 Intel 均可；下文命令以 zsh 为例） |
| Xcode | **Xcode 26 或更新**（`xcrun simctl` / `xcodebuild` 必须可用；`iPhone Duo` 折叠屏设备类型出现在 Xcode 27.1） |
| Node.js | **≥ 22.6**（Harness 运行时；插件本身零运行时依赖） |
| 模拟器 | 任一已安装的 iOS Simulator runtime（`xcodebuild -downloadPlatform iOS` 可装） |
| 可选 | [fb-idb](https://github.com/facebook/idb)（**仅** `simulator_tap` / `simulator_elements` 需要，见下节） |

### 安装

插件以 **bundle** 形式安装（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者负责插入插件行）：

```sh
# 从 profile 安装；等价于 plugin_manager 的 action: install_bundle
dsh plugin --profile "$DSH_PROFILE" install /path/to/Tools/ios-dev-helper
```

> **网络受限的兜底**：**若网络受限，请下载 ZIP 包后在 DSH 客户端填入本地绝对路径**（即上面 `install` / `install_bundle` 的路径参数，指向解压后的 `ios-dev-helper` 目录）。插件运行时不需要联网，也不需要 `npm install`——只有改动 `src/` 时才需要 TypeScript 工具链。

安装成功的标志：

1. 工具列表里出现 **12 个**工具，且每个描述尾部带 `[ios-dev-helper vX.Y.Z]`（这是"当前到底加载了哪一版"的指纹，见[如何判断当前加载的版本](#如何判断当前加载的版本)）。
2. 系统提示里出现 `## iOS development conventions (ios-dev-helper vX.Y.Z)` 段落。
3. 宿主侧插件模块在进程启动时被缓存：**改完代码必须重启 DSH** 才会生效（`dsh-hmr` 不覆盖 `link:` 依赖）。

## 🔌 可选依赖：安装 idb

> **仅在使用 `simulator_tap` 和 `simulator_elements` 时需要。** 其余 10 个工具不依赖任何外部 CLI（除 Xcode 自带组件）。

`simulator_tap` / `simulator_elements` 需要 [fb-idb](https://github.com/facebook/idb) 客户端及其 `idb_companion` 守护进程。本文假设的目录布局：

```
~/.dsh/tools/idb/
├── bin/idb            # wrapper: puts ./companion on PATH, execs venv/bin/idb
├── bin/uv             # the toolchain installer used below
├── companion/         # idb_companion (prebuilt, macos-arm64)
├── python/            # user-space CPython 3.12 (python-build-standalone)
└── venv/              # fb-idb 1.6.5
```

无需 Homebrew、无需 sudo、不触碰系统 Python：

```sh
# 1. idb_companion（请用 GitHub release API 的 digest 核对 sha256）
curl -L -o companion.tgz \
  https://github.com/facebook/idb/releases/download/v1.6.5/idb-companion.macos-arm64.tar.gz
mkdir -p ~/.dsh/tools/idb/companion && tar -xzf companion.tgz -C ~/.dsh/tools/idb/companion

# 2. 用户态 CPython 3.12（fb-idb 要求 >=3.10；macOS 自带 3.9）
curl -L -o py.tgz \
  'https://github.com/astral-sh/python-build-standalone/releases/download/20261001/cpython-3.12.15%2B20261001-aarch64-apple-darwin-install_only.tar.gz'
mkdir -p ~/.dsh/tools/idb/python && tar -xzf py.tgz -C ~/.dsh/tools/idb/python --strip-components=1

# 3. 客户端，版本与 companion 对齐
~/.dsh/tools/idb/python/bin/python3.12 -m venv ~/.dsh/tools/idb/venv
~/.dsh/tools/idb/venv/bin/pip install 'fb-idb==1.6.5'

# 4. wrapper，让 companion 可被发现
printf '#!/bin/sh\nDIR="$(cd "$(dirname "$0")/.." && pwd)"\nPATH="$DIR/companion:$PATH"\nexport PATH\nexec "$DIR/venv/bin/idb" "$@"\n' \
  > ~/.dsh/tools/idb/bin/idb && chmod +x ~/.dsh/tools/idb/bin/idb

# 5. 验证
~/.dsh/tools/idb/bin/idb ui describe-all --udid "$(xcrun simctl list devices booted -j \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next(iter(d.values()))[0]["udid"])')" | head -c 200
```

遇到过的两个坑：

- 客户端与 companion 必须处于**同一版本族**：fb-idb 1.1.7 配 idb_companion 1.6.5 会在握手时报 `IdbJsonException: Failed to parse json from:`。请用 `fb-idb==1.6.5`。
- `idb_companion` 会写入 `~/Library/Developer/CoreSimulator/Devices/<UDID>/data/fbsimulatorcontrol/`。受 DSH **文件沙箱**约束的进程（例如 `bash` 工具）写不进去，会失败并报 `Failed to create xctest storage location`；插件自己的子进程不受该沙盒约束，所以工具能正常工作而沙盒 shell 不能。

显式指定路径可以让插件更可移植：

```yaml
config:
  idbPath: ~/.dsh/tools/idb/bin/idb   # 行首 ~ 由插件展开
```

## 🧰 工具全景

| 工具 | 分类 | 一句话 |
|---|---|---|
| `xcode_build` | 构建 | 运行 `xcodebuild` 并解析诊断：定位错误→`file:line:col`，无定位失败→`<producer>: severity: message`；警告可致命，连续失败会建议清理。 |
| `xcode_info` | 构建 | 报告发现的 target、schemes 与可用 runtime；首次构建前用它确认 scheme。 |
| `ios_dependencies` | 构建 | 按磁盘清单自动跑 `pod install` / `swift package resolve`，缺 CLI 也明确报错。 |
| `simulator_control` | 模拟器 | 模拟器生命周期：`list`/`boot`/`shutdown`/`booted`/`open`/`erase`/`delete`/`runtime_list`。 |
| `simulator_install_launch` | 模拟器 | 安装 `.app` 并（可选）启动；瞬时故障重试一次，超时与耗时都如实报出。 |
| `simulator_screenshot` | 模拟器 | 截图并自动附图；`display` 可指定面板（`LCD` / `LCD-1`）。 |
| `simulator_logs` | 模拟器 | 监听统一日志一小段时间，只回 `error`/`fault`，条数与字符都受控。 |
| `simulator_tap` | UI 自动化 | 按坐标或 `accessibility_id` 点按（`idb ui tap`），默认点完截图。 |
| `simulator_elements` | UI 自动化 | 导出无障碍元素树（标签、identifier、中心点），供点按定位。 |
| `ios_verify_ui` | UI 验证 | 按验收标准判定当前界面：两阶段协议，返回 `{ passed }` 或 `{ passed: false, reason, nextSteps }`。 |
| `duo_fold_state` | UI 验证 | 折叠屏面板识别 + **像素级**点亮判断；角度如实标记为不可用。 |
| `cleanup_environment` | 环境 | 清残留进程 / DerivedData 构建态 / 已启动模拟器；**默认只报告**。 |

## 🔬 深度技术指南

<details>
<summary><b><code>xcode_build</code> — 构建、诊断解析与门禁机制</b>（点击展开查看详情）</summary>

运行 `xcodebuild` 并把诊断解析成条目：带位置的 `error`/`warning` 变成 `file:line:col: severity: message`，`xcodebuild` 级、无位置的失败（找不到 scheme、destination 不匹配）变成 `<producer>: severity: message`。

**严重级别匹配刻意大小写不敏感**：编译器写小写 `error:`/`warning:`，而 `xcodebuild` 自己的诊断是大写——`--- xcodebuild: WARNING: Using the first of multiple matching destinations:`。只匹配小写时，一个它警告过的运行会被报成 `0 warning(s)`，在 `treatWarningsAsErrors` 下被当成干净通过。

- 自动发现工作目录下的 `.xcworkspace`/`.xcodeproj` 与 scheme。多 scheme 时选与工程/工作区同名者（Xcode 对 app target 的惯例）并在 notes 说明；用 `scheme` 覆盖。
- **显式 `target` 在 spawn 之前校验**：路径不存在立即失败，并列出目录里真实存在的候选，而不是先付一次完整 `xcodebuild` 启动再报一句"does not exist"。
- `configuration` 仅在显式给出时追加为 `-configuration <value>`；省略时沿用 scheme 自身配置，工具不强行指定。（2026-10-16 之前该值被接受却从未使用，`configuration: "Release"` 静默构建 Debug。）
- 原始输出无法解释的失败会被翻译：写权限特征（`Operation not permitted`、`… is not writable`）变成 summary 子句 + 指出该查哪些路径与权限的 note。
- `action`：`build`（默认）、`test`、`clean`、`build-for-testing`、`test-without-building`。
- `onlyTesting` 把测试动作收窄到指定标识符，逐个追加为**连写**的 `-only-testing:<id>`（本仓库 `Tools/run_tests.sh` 用的形态；对照实验显示 `-only-testing <id>` 也能解析，而未知 flag 会以 `invalid option` 失败）。标识符形如 `TestTarget[/TestClass[/TestMethod]]`，数组会 trim 并去重。
  - 校验发生在 **spawn 之前**：非数组、空数组、或含非空字符串以外的元素，都会直接失败并在消息里点明，绝不启动 `xcodebuild`。
  - 旧的 `only_testing` 拼写仍作为隐藏别名可用，但不再出现在 schema 里。
  - 非测试动作下 `xcodebuild` 会忽略该 flag，工具因此加 note 说明，而不是暗示已过滤。
- 省略 `destination` 时由 `simulator` + `os` 组合，例如 `simulator: "iPhone 17 Pro"`、`os: "26.5"`。你显式要求的 destination（或具名 `simulator`）对**任何**动作都生效，包括 `clean` 与 `build-for-testing`——否则它们不带目的地运行，`xcodebuild` 自己去猜，并可能清掉另一个目的地的产物。
- `warningCount > 0` 且 `treatWarningsAsErrors` 开启时把构建标为 not-ok，对应本仓库 `Tools/run_tests.sh` 的"编译器警告即失败"规则。
- **连续失败三次，结果末尾会建议清理**。`xcode_build` 按工作目录统计连续失败次数，达阈值时追加一个结果块："检测到连续失败 N 次，建议调用 cleanup_environment 清理缓存"——因为"一分钟前还能构建、现在不行"通常是残留的 `xcodebuild` 或卡死的 DerivedData 数据库，而不是代码问题。构建成功即清零；计数器随插件实例存在（重启/重载清零）。
- **没有执行任何测试的测试动作是失败，不是通过**。`xcodebuild` 在过滤条件匹配不到时会退出 0 并打印 `** TEST SUCCEEDED **`（`Executed 0 tests`），所以工具读 `Executed N test(s)` 计数，报 `ok: false` 与 `xcodebuild test ran no tests`，并附 note 提示检查拼写。每个测试动作都会返回 `executedTests` 并在 notes 提到。已在本仓库验证：方法级标识符恰好跑 1 个测试并通过；同样命令拼错方法名则跑 0 个，现在被报为失败。（`build-for-testing` 只构建，故不适用。）
- `shutdown_simulators`（默认 `false`）用来挡住本仓库 `Tools/run_tests.sh` 记录过的陷阱：UI 通道跑在残留模拟器状态上会产生**看起来像业务 bug 的随机单测失败**。测试动作总会检查已启动模拟器，要么先全部关闭（`shutdown_simulators: true` → `xcrun simctl shutdown all`），要么警告并列出设备名。实测：同一条通道命令在脏模拟器上 `ok: false` 且 2 个断言失败，`simctl shutdown all` 之后 `ok: true`、13 通过 / 3 跳过。非测试动作（`build`、`clean`、`build-for-testing`）不产生额外 `simctl` 调用，也绝不关闭任何设备。
- 以 `isConcurrencySafe: () => false` 运行：并行 `xcodebuild` 会通过共享模拟器与 DerivedData 相互干扰。

</details>

<details>
<summary><b><code>xcode_info</code> / <code>ios_dependencies</code> — 发现与依赖解析</b>（点击展开查看详情）</summary>

**`xcode_info`** 报告发现的 target、其 schemes 与可用的模拟器 runtimes。首次 `xcode_build` 前若不确定 scheme，先调它。

**`ios_dependencies`** 在首次构建前解析依赖：按磁盘上已有的清单自动判断（而不是靠 flag），工作目录是配置的 `workspaceRoot`（即仓库根）：

| 发现 | 命令 |
| --- | --- |
| `Podfile` | `pod install` |
| `Package.swift` | `swift package resolve` |

两者同时存在时按此顺序都跑（项目可能既有 Podfile 又有本地 SwiftPM 包）。两者都不存在算失败，消息会点明目录并提示用 `cwd`。

- 每命令预算 `dependenciesTimeoutMs`（默认 300000，即 5 分钟），可被调用级 `timeout_ms` 覆盖（钳制到 1000–3600000）。超时被报为失败并在 notes 点名。
- CLI 缺失会被报告，绝不静默跳过。本机实测：`pod` **未安装**，于是有 `Podfile` 时返回 `ok: false` 与 ``CocoaPods: `pod` could not be launched — it is not installed or not on PATH``，结果自带的输出也说明进程根本没起来。这需要 `runCommand` 的一处修复：从未启动的进程没有退出状态，过去会产出既无输出又只有"failed in 0s"的结果。
- `swiftPath`/`podPath`（配置）会展开 `~`，因为这些 CLI 常装在默认 `PATH` 之外（rbenv、工具链管理器）。
- 已在本仓库验证：`Package.swift`（无远程依赖）→ `swift package resolve` 约 1 秒、`ok: true`，且**仓库里没有多出文件**（无需解析，故无 `Package.resolved`）。

</details>

<details>
<summary><b><code>simulator_control</code> / <code>simulator_install_launch</code> — 生命周期与安装</b>（点击展开查看详情）</summary>

**`simulator_control`**：`action` 取 `list`、`boot`、`shutdown`、`booted`、`open`、`erase`、`delete`、`runtime_list`。`device` 接受名称、UDID、**设备类型**（`iPhone-Duo` 或 `com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`）或 `booted`。`erase` 与 `delete` 需要 `confirm: true`；对已启动设备再 `boot` 视为成功而非错误。设备类型匹配用的是 `simctl list devices -j` 里已有的 `deviceTypeIdentifier`，大小写不敏感，因此"实例名"与"类型名"不一致的折叠屏也能寻址。

**`simulator_install_launch`** 安装构建好的 `.app` 并可启动。`bundle_id` 启动时必填、仅安装时可选。

- 安装预算为 `simctlTimeoutMs`（默认 2 分钟），因为大 `.app` 需要拷进设备容器。安装与启动都会报告耗时，慢包可见而不是靠猜。
- **只对基础设施型瞬时故障重试一次**。失败安装若输出匹配 `FLAKY_SIMCTL_PATTERN`（与本仓库 `Tools/run_tests.sh:50` 视为可重试的信号一致）会在 1 秒后重试一次；真实失败（缺 bundle、磁盘满）绝不重试，对应项目"真实失败要报告不要重试"的规则。
- **超时会被点名，不会静默吞掉**。被预算打断的安装读作 `install timed out after N ms (…)`，被打断的启动读作 `launch timed out after N ms`，各自附一条指向 `simctlTimeoutMs` 的 note。只是**跨过**预算但自行完成的操作报为成功并附 note，绝不谎称超时。
- 工具声明的上限是 `simctlTimeoutMs × 7 + 30s`：boot（1×）+ 安装含重试（2×）+ 启动（`--console-pty` 流式到应用退出时 4×）。声明过低会让 Harness 取消一个仍在合法工作的调用。

</details>

<details>
<summary><b><code>simulator_screenshot</code> — 截图、自动附图与分屏</b>（点击展开查看详情）</summary>

用 `xcrun simctl io <device> screenshot <file>` 截取当前屏幕，返回 PNG 的**绝对路径**，可用 `read_image` 查看。

- 不给 `path` 时写到 `<cwd>/<screenshotDir>/screenshot-<UTC 时间戳>.png`（目录按需创建）；显式 `path`（绝对或相对 `cwd`）覆盖它。
- `device` 接受名称、UDID、**设备类型**（`iPhone-Duo` 或全限定标识符）或 `booted`（默认）。
- `display` 用于单独截取某个面板，底层追加 `--display=<value>`（放在路径之前，符合 `screenshot [--type] [--display] [--mask] <file>` 的参数顺序）。折叠屏上面板是 `LCD`（外屏）与 `LCD-1`（内屏）；折叠状态下未点亮的那块会截出纯黑，因此需要显式点名。合法取值就是 `xcrun simctl io <device> enumerate` 报告的内容：屏幕名、屏幕 ID、`primary` 或 UUID。不传则维持单屏行为不变。
- **截图会作为 `ImageBlock` 附到对话里**（经可选的 `attachments` 服务），模型无需再调 `read_image`。`attach: false` 可关闭；服务缺失或存储拒绝时，工具仍成功，返回路径并附 note 说明为何没附图。
- 退出码为 0 也不能全信：工具会 `stat` 文件，没有可读图像就报失败；没有已启动模拟器时也会明说。

</details>

<details>
<summary><b><code>duo_fold_state</code> — 折叠屏面板识别（含"角度为何不可用"）</b>（点击展开查看详情）</summary>

报告折叠屏模拟器（如 **iPhone Duo**，Xcode 27.1 的设备类型 `com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`）的面板状态。

- 面板来自 `xcrun simctl io <device> enumerate`，它把面板列成 `(1) LCD:` / `(3) LCD-1:` 这样的块：`LCD` 是外屏，`LCD-1` 是内屏。
- 随后对每块集成面板截图**并测量像素**。这一步很关键：折叠状态下未点亮的面板是纯黑，但 PNG **仍有约 106 KB**，文件大小完全证明不了内容。工具因此报告 `litRatio`（采样到的非黑像素占比）与 `blank`（< 0.1%），并以比例更大者作为 `activePanel`；两块都在渲染（展开/并排）时会直接说明，而不是硬挑一块。
- **铰链角度不可用，工具绝不编造**：`devicectl` 没有 `device motion` 子命令（只有 `orientation get|set|rotate`，那是屏幕旋转）；`devicectl device info displays` 对模拟器返回 `CoreDeviceError 1001 (com.apple.coredevice.feature.getdisplayinfo)`；`simctl io … enumerate` 也没有姿态字段。`angleUnavailable` 会把这三条证据照实写出。
- `capture: false` 只报告枚举结果，不写任何文件。

</details>

<details>
<summary><b><code>ios_verify_ui</code> — 验收标准与两阶段协议</b>（点击展开查看详情）</summary>

按一句自然语言验收标准检查屏幕，例如 `"屏幕上应该出现日历和日期选择器"`。

**工具本身没有眼睛**，所以这是刻意的两阶段协议，而不是一次"魔法调用"：

1. **第一阶段** — 只传 `acceptance_criteria`。它截屏（`<cwd>/<screenshotDir>/verify-<UTC 时间戳>.png`，像 `simulator_screenshot` 一样以 `ImageBlock` 附图），返回标准、路径与"请具备视觉能力的模型据此判断"的指示。**它从不伪造判定**。
2. **第二阶段** — 用同一 `acceptance_criteria` 加 `passed`（失败时再加 `reason`）再调一次。返回 `{ passed: true }`，或 `{ passed: false, reason, nextSteps }`，后者给出可执行的补救：用 `simulator_elements` 看屏幕上究竟有什么、若画面在动画中途就重截、若 UI 确实缺失就改 SwiftUI 代码，再 `xcode_build` → `simulator_install_launch` → 重新验证。

`ok` 在标准**未达成**或检查根本跑不起来时为 false；`status` 用于区分（`failed`、`capture-failed`、`no-device`、`invalid-arguments`，以及第一阶段的 `awaiting_vision_judgement`）。`passed: false` 却不给 `reason` 会被拒绝：无法解释的失败既不能修，也不能事后审计。

**为什么不一次调用直接返回判定？** 那意味着插件自己再发一次模型请求（`ctx.get('llm')` → `prepareCall` → `stream`，并检查 `inputModalities` 是否含 `image`）。技术上可行，但每次验收都会多花一次带凭据的计费请求，去重复调用方本来就要做的判断，还会悄悄改变"这是谁的意见"。需要这个变体可以提。

</details>

<details>
<summary><b><code>cleanup_environment</code> — 环境善后与防误杀机制</b>（点击展开查看详情）</summary>

在意外中断后恢复机器——被取消的构建、崩掉的 Xcode、被落下的模拟器。三个步骤，全部报告：

1. **三类残留进程。** 对 `xcodebuild`、`simctl … log stream`、`idb_companion` 分别 `pgrep -fl`，每条发现都以 `[class] <pid> <command line>` 报告，PID 与进程名都可见。只有 `xcodebuild` 会在命令行里写出工作区，因此它被过滤为**只匹配本工作区或其 DerivedData** —— 其余一律不动并说明，这样你自己在 Xcode 里开的构建能活下来。另两类按设备 UDID 匹配（它们的命令行从不提工作区），`idb_companion` 天生属于模拟器作用域且按需重生。终止策略是 `SIGTERM`，等 `graceMs`（与 subprocess 服务给子进程的宽限一致）后对仍活着者 `SIGKILL`，仍不死的会进 `survived`，而不会被悄悄算作"已清理"。
2. **陈旧的 DerivedData 构建态。** 遍历 Xcode 真正留下的产物（在真实 DerivedData 上实测：`Build/Intermediates.noindex/XCBuildData/build.db` 与 `<hash>.xcbuilddata` 目录）以及 `*.lock`/`*.lockfile`，**只删除超过 `stale_minutes`（默认 30 分钟）未改动者** —— 在跑构建的数据库靠规则保护，而不是靠运气。`remove_build_database: true` 才无视时效，代价是下次构建失去增量状态。
3. **已启动的模拟器。** `simctl shutdown all`，并先报告关掉的是哪些设备。

**默认只报告，除非 `auto_clean: true`。** 先不带它跑一次，看清会做什么；那份报告本身就是"留下了什么"的记录。

</details>

<details>
<summary><b><code>simulator_logs</code> — 受控的日志窗口</b>（点击展开查看详情）</summary>

用 `xcrun simctl spawn <device> log stream --level=debug` 监听已启动模拟器的统一日志，并只报告 `error` 与 `fault` 条目，最新的在最后。

- 流本身不会自己结束，所以 `seconds`（默认 5，钳制 1–60）后停止。本项目的模拟器上实测精度：5 秒窗口约 5136 ms。
- **`error`/`fault` 的筛选发生在 `log` 内部**，而不是事后过滤：给 `log stream` 传入针对 Error（logType 16）与 Fault（logType 17）消息类型的 `--predicate`，并加 `--style=ndjson` 以获得可机器解析的记录。不加过滤的 `--level=debug` 每 5 秒约 600 KB；同样窗口加上谓词后只剩几行。
- `max_lines`（默认 200，钳制 1–2000）保留**最新**的匹配条目。渲染文本再受 `maxOutputChars` 约束，单条失控消息在 400 字符处截断，保证上下文很小。实测：513 行 / 620 KB 的采集被压缩成 572 字节的 `error`/`fault` 文本。
- 自己以非零状态退出的流（谓词写错、设备不存在）算失败；因为被工具停掉而结束的窗口不算。

</details>

<details>
<summary><b><code>simulator_tap</code> / <code>simulator_elements</code> — 点按与元素树</b>（点击展开查看详情）</summary>

**`simulator_tap`** 在绝对坐标（`x`、`y`）或持有 `accessibility_id` 的元素上点按。

**`xcrun simctl` 没有 tap 命令。** 其 `io` 操作只提供 `enumerate`、`poll`、`recordVideo`、`screenshot`、`screenConfig`，`xcrun simctl io booted tap x y` 会以退出码 117 报用法错误。因此触摸注入走 **`idb`**（`idb ui tap`），这是唯一受支持的通路——见[安装 idb](#-可选依赖安装-idb)。

- 坐标是**点**而不是像素：逻辑屏幕，例如 iPhone 17 Pro 的 `402x874`，而非 `1206x2622` 的截图栅格。
- 给出 `accessibility_id` 时，工具用 `idb ui describe-all` 读树并点击匹配元素的 frame 中心。匹配顺序：精确 `AXUniqueId` → 精确 label → 不区分大小写 → 子串；并列时取最小 frame。**`Application` 节点永不参与匹配** —— `describe-all` 总把前台应用报成一个以自身命名的全屏元素，匹配它只会点屏幕正中。
- 标识符用 `simulator_elements` 发现；查找失败会返回首批候选，调用方可直接重试而不必再调一次。
- **一次调用完成"点 + 看"**：默认等待 `settle_ms`（默认 700，钳制 0–10000）让动画收尾，随后截屏并以 `ImageBlock` 附图，无需再调 `simulator_screenshot`。`screenshot: false` 可只点不拍。截图失败不会让点按失败：结果保持 `ok` 并附 note。
- companion 自愈：若 `idb` 因域套接字消失而无法连上 companion（宿主重启清掉、重启设备、手工 `kill`），工具会从 `/tmp/idb/state` 删除不可达记录——那是 `idb` 硬编码且自己不会清理的注册表——然后重试一次并在 notes 说明。只有套接字文件确实缺失的记录才会被删除，活着的 companion 绝不被打扰。

**`simulator_elements`** 列出无障碍元素及其 identifier 与点按中心，读自 `idb ui describe-all`。`query` 对 label 或 identifier 做不区分大小写的过滤，`max_elements`（默认 60）限制条数。它是 `simulator_tap` 的 `accessibility_id` 模式的发现侧。

</details>

## 🧱 架构与限制

### 目录结构

| Path | Role |
|---|---|
| `src/index.ts` | 插件源码 —— 要改就改它。 |
| `lib/index.js` | 构建产物入口。**DSH 加载的就是它。** |
| `lib/types/index.d.ts` | 生成的类型声明。 |
| `tsconfig.json` | 构建配置。 |
| `package.json` | 清单；`dsh.bundle.patch` 标记本包为 bundle。 |
| `cordis.patch.yml` | 负责插入插件行的 bundle patch。 |

### 为什么需要构建步骤

Node 拒绝为真实路径位于 `node_modules` 目录下的模块剥离 TypeScript 类型（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），而 `install_bundle` 会把本包链接进 profile 的 `node_modules`。因此 `.ts` 入口无法作为已安装插件激活。`package.json` 因此指向构建后的 `lib/index.js`，`src/index.ts` 保持为作者源码。

改完 `src/` 后重建：

```sh
npm install        # 一次性：安装仅开发用的 TypeScript 工具链
npm run build      # tsc -p tsconfig.json  ->  lib/index.js + lib/types/
```

`typescript` 与 `@types/node` 属于 `devDependencies`；运行时不需要它们，所以已安装的插件保持零依赖。

### 配置项

取值来自 `cordis.patch.yml` 的 `config:` 块，由插件在激活时校验（没有 `Config` 导出，因此不引入 schemastery 依赖）。未知键被忽略，缺失键取默认值。

| 键 | 默认值 | 含义 |
|---|---|---|
| `workspaceRoot` | `''`（用 Agent 的 cwd） | 把构建固定到某个 checkout。 |
| `xcodebuildPath` | `xcodebuild` | 绝对路径或 PATH 名称。 |
| `xcrunPath` | `xcrun` | 绝对路径或 PATH 名称。 |
| `derivedDataPath` | `.dsh/DerivedData` | `xcodebuild` 存放中间产物的位置，使重复构建保持增量。相对值按构建工作目录解析，结果**始终**以 `-derivedDataPath <path>` 传入。优先级：调用级 `derived_data_path` 参数 → 本键 → 默认值。应用它的代价是工作区首次切换位置时全量重建一次（目录由 `xcodebuild` 创建）。 |
| `screenshotDir` | `.dsh/screenshots` | 未给显式 `path` 时 `simulator_screenshot` 的写入位置；相对构建工作目录。 |
| `idbPath` | `idb`（PATH 查找） | `simulator_tap` 与 `simulator_elements` 使用的 `idb` CLI。行首 `~` 展开为家目录。用上面的布局时设为 `~/.dsh/tools/idb/bin/idb`。 |
| `idbTimeoutMs` | `120000` | 单次 `idb` 调用预算；会话内首次调用还会启动 companion 守护进程。 |
| `podPath` | `pod`（PATH 查找） | `ios_dependencies` 使用的 CocoaPods CLI。行首 `~` 展开。 |
| `swiftPath` | `swift`（PATH 查找） | `ios_dependencies` 使用的 SwiftPM CLI。Xcode 工具链的 `swift` shim（`/usr/bin/swift`）可用。 |
| `dependenciesTimeoutMs` | `300000` | 单次 `pod install` / `swift package resolve` 预算；5 分钟，因为冷启动的 `pod install` 要下载 pods。 |
| `buildTimeoutMs` | `900000` | 单次 `xcodebuild` 预算。 |
| `simctlTimeoutMs` | `120000` | 单次 `simctl` 调用预算。 |
| `maxOutputBytes` | `8388608` | 每路采集器预算。 |
| `maxDiagnostics` | `40` | 呈现给模型的 **error/warning** 诊断条目上限；`note` 行从不呈现。上限只限制条目数——summary 仍统计全部诊断，并附省略说明告知漏掉多少。 |
| `maxOutputChars` | `6000` | 呈现给模型的原始输出尾部长度。 |
| `graceMs` | `3000` | SIGTERM→SIGKILL 宽限。 |
| `injectSwiftUIGuidance` | `true` | 是否注册提示词段落。 |
| `treatWarningsAsErrors` | `true` | 仅有警告的构建也算失败。 |

### 安全与沙盒

这些工具以 Harness 进程自身的权限拉起子进程。它们**不受**约束 `bash` 工具的 DSH **文件沙盒**限制，因此 `xcodebuild` 能访问 `~/Library/Caches` 与 DerivedData。subprocess 服务会从子进程环境里剔除凭据形状的变量名（`*KEY*`、`*PASSWORD*`、`*SECRET*`、`*TOKEN*`）以及所有 `DSH_*` 名称。

### Notes and limits

- **取消会传到子进程**：宿主的 abort 信号转发给每条被 spawn 的命令（模拟器工具则是 `process.terminate()`），所以取消一次工具调用会终止它启动的东西，而不是留下一个构建、安装或 `log stream` 继续跑——并且 `runCommand` 在该路径上也会等待进程范围真正静止，而不只在超时才等，因此被取消的 `xcodebuild` 不会在工具已经返回后还留着编译子进程占着构建数据库。若在 `graceMs + 2000` ms 内无法证明静止，结果会明说而不是假装。已被取消的工具仍可能 spawn 后续命令；那些命令以已中止状态出发并立即被杀，且 `simulator_install_launch` 取消后绝不重试。
- **截图留在工作区内**：`.dsh/screenshots/`（以及默认 `derivedDataPath`、`.dsh/DerivedData`）位于仓库内，所以 `.dsh/` 应进 `.gitignore`。部署侧的图像限制（默认每图 20 MB、单边 8192 px、解码后 64 Mpx）作用于附图；更大的截图仍会落盘，只是不内联附图。
- **诊断而非原始日志**：诊断条目只含 `error` 与 `warning`；`note` 行（输入编码、依赖顺序噪音）被丢弃，以免干净构建显得可怕。原始日志只保留**最后** `maxOutputChars` 个字符，因为构建日志的结论在末尾；需要更多就调高该键。
  - 来自 `Tools/run_tests.sh` 的 SwiftPM/沙盒缓存白名单（`org.swift.swiftpm`、`not writable`、`readonly database`）**只过滤警告**，与该脚本的用法一致。2026-10-16 之前本插件对所有严重级别都套用它，静默吞掉了真实的 `error:` 行——其中包括权限失败那句"… is not writable"。
- `simulator_control` 刻意不提供 `spawn` 动作；任意进程执行仍归 `bash`。

### 测试

```sh
npm test           # 先编译，再跑 node --test "test/*.test.mjs"
                   # 引号形式：由 Node 自己展开 glob，不依赖调用方 shell
                   #（cmd.exe 与 PowerShell 不展开通配符）
```

测试套件不需要测试框架、不需要网络：它用一个打桩的 `subprocess` 服务（`test/support/harness.mjs`）驱动插件，并断言工具**实际**要求外部世界做什么。

- `test/xcode-invocation.test.mjs` 对纯函数 `buildXcodeInvocation` 做单元测试（这也是它被导出的原因）：精确的 argv、DerivedData 优先级与 `onlyTesting` 校验都能直接断言，无需进程、无需桩件。
- `test/xcode-build.test.mjs` 覆盖工具行为：target 预检、诊断条数上限与计数、写权限归因、预算结局与截断安全。
- `test/simulator-tools.test.mjs` 覆盖模拟器输入校验、安装重试/超时策略，以及宿主取消是否到达每条被 spawn 的命令。
- `test/duo.test.mjs` 覆盖折叠屏：按名称/UDID/设备类型寻址、按真实 `enumerate` 形状解析面板、用真实 PNG 验证像素级黑屏判断、`--display` 参数顺序。
- `test/cleanup.test.mjs` 覆盖环境清理的"谨慎性"：无 `auto_clean` 不发任何信号、别人的 `xcodebuild` 不被杀、新鲜构建数据库默认存活、无视 SIGTERM 的进程被升级为 SIGKILL。
- `test/version-stamp.test.mjs` 守住 12 个工具描述与提示段标题里的版本戳。

`pnpm test` 等价，CI 会在构建后运行它。

### 真实环境集成测试

`test/integration.test.mjs` 是可选开启的，默认跳过（CI 没有 Xcode 与模拟器）。它会用真实 `xcodebuild` 构建一个真实工作区、把产物安装并启动到真实模拟器上，并且——最关键的一项——**把插件的诊断计数与它实际看到的原始日志对账**；解析器漏掉真实警告时就是靠这一步被抓出来，而不是报成干净通过。

```sh
IOS_HELPER_INTEGRATION=1 \
IOS_HELPER_INTEGRATION_ROOT=/path/to/project \
IOS_HELPER_INTEGRATION_SIMULATOR='iPhone 17 Pro' \
IOS_HELPER_INTEGRATION_BUNDLE_ID=com.example.app \
  node --test test/integration.test.mjs
```

它自带一份真实的 `subprocess` 实现（`test/support/real-subprocess.mjs`），因为独立 Node 进程借不到 Harness 的服务。

### 如何判断当前加载的版本

`package.json` 的版本号会被盖章进**每个工具描述**（尾部 `[ios-dev-helper vX.Y.Z]`）与提示段标题。这很重要：宿主会一直服务它启动时 import 的模块，磁盘上重建过的 `lib/index.js` 与真正重载过的插件从外部看毫无区别；没有版本戳时，这两者只能靠手工 diff 一个参数描述来分辨（历史上确实如此）。

想知道线上是哪一版，读任意一个工具的描述（例如通过 Tool inspect provider，或模型看到的工具列表）并和 `package.json` 对比。若不一致，说明宿主早于你的改动：**重启 DSH**——宿主侧插件模块在进程生命周期内被缓存（`dsh-hmr` 不覆盖 `link:` 依赖）。
