# codex-desktop-android-tool

把 Android 设备接进 ChatGPT 桌面应用 / Codex 的插件。

复用 `dsh-android-tool` 的 `lib/` 核心（adb、scrcpy、logcat、性能、AAB→APK），外面包一层 MCP stdio server。

## 工具

| 工具 | 作用 |
|---|---|
| `android_view` | 截图当前画面，返回 MCP image content |
| `android_state` | 型号、Android 版本、电量、WiFi、内存、存储、屏幕、前台应用 |
| `android_control` | tap / long_press / swipe / key / text / scroll / wake / open_app / gamepad |
| `android_adb` | 兜底：执行任意 adb 命令 |
| `android_aab2apk` | `.aab` → 已签名 `.apk` |
| `android_panel` | 面板后端：设备列表 / 选择 / 刷新（模型一般不需要直接调用） |

## 右侧「安卓设备」面板（MCP Apps）

面板由 MCP Apps 资源 + `android_panel` 工具的 `_meta['openai/ui'].entrypoints = [{ type: 'thread' }]` 声明；宿主把它挂到对话右侧标签栏。面板只通过宿主的 `tools/call` 桥调用本插件的工具，**不使用本地 HTTP / WebSocket**，也不监听端口。

要求：

- Codex 桌面版 `26.1103.3517.0` 或更新（旧版本没有 MCP Apps 侧面板）。
- MCP Apps 功能已启用：`codex features enable enable_mcp_apps`（写入 `config.toml` 的 `features.enable_mcp_apps = true`），重启桌面端。

打开方式：在 Codex 会话里安装并启用本插件后，右侧面板会出现「安卓设备」标签；若没有出现，按下面的故障排查检查功能开关与插件版本。

面板标签：**设备 / Logcat / 性能 / AAB→APK**。

已实现：设备列表与显式选择、截图与手动刷新、点击/滑动/返回/Home/唤醒、错误/未授权/离线/息屏提示、横竖屏坐标映射（`object-fit: contain` 留边不上报输入）、面板关闭时清理计时器与未完成请求；Logcat 启动/停止/级别过滤/导出；CPU/内存/GPU/电池性能采样；AAB→APK 转换表单。

未实现：实时视频（当前是截图刷新，不是实时视频）。


## 安装

### 方式 1：本地 marketplace

marketplace 根目录里需要有 `.agents/plugins/marketplace.json`，且 `source` 指向的插件目录要在这个根目录内部（父目录/绝对路径会被忽略）。本仓库根目录的 `.agents/plugins/marketplace.json` 已按此配置好：

```powershell
codex plugin marketplace add "<本插件仓库路径>"
codex plugin add codex-desktop-android-tool@codex-work-plugins
```

安装产物落在 `<CODEX_HOME>\plugins\cache\codex-work-plugins\codex-desktop-android-tool\0.2.3`，并自动启用。然后在 ChatGPT 桌面应用的 Codex 模式里开始新会话，输入 `@` 或 `$` 选择插件/技能。

### 方式 2：直接配 MCP server

```powershell
codex mcp add android-tool -- node "<本插件目录>\server.mjs"
```

> Windows 上 `codex` 可能不在 PATH，CLI 实际位于 Codex 安装目录下的 `bin\<hash>\codex.exe`，用完整路径调用即可。

### 方式 3：发到 GitHub，别人一条命令装

把插件目录做成一个 marketplace 仓库（仓库根同时作为插件根），根下放 `.agents/plugins/marketplace.json`：

```json
{
  "name": "codex-work-plugins",
  "plugins": [
    { "name": "codex-desktop-android-tool", "source": ".", "category": "Tools" }
  ]
}
```

`source` 用 `.` 表示插件就在仓库根；多插件仓库可写成 `./plugins/codex-desktop-android-tool`，但插件目录必须在 marketplace 根目录内部（父目录、绝对路径会被忽略）。

别人安装：

```powershell
codex plugin marketplace add TouMingQAQ/codex-desktop-android-tool
codex plugin add codex-desktop-android-tool@codex-work-plugins
```

也可以给完整 URL、指定分支：

```powershell
codex plugin marketplace add https://github.com/TouMingQAQ/codex-desktop-android-tool --ref main
```

更新已安装的插件：

```powershell
codex plugin marketplace upgrade codex-work-plugins
codex plugin remove codex-desktop-android-tool@codex-work-plugins
codex plugin add codex-desktop-android-tool@codex-work-plugins
```

发布前注意：

- 必须把 `node_modules/`（约 3.3 MB）一起提交 —— `codex plugin add` 只拷贝文件，不会跑 `npm install`。
- `scrcpy/adb.exe` 只有 Windows 版；macOS / Linux 用户需在配置里指定自己的 adb。
- 插件目录约 43 MB，最大单文件 `tools/bundletool-all.jar` 约 31 MB，未超 GitHub 单文件 100 MB 限制。
- 发新版要同时改 `package.json` 与 `.codex-plugin/plugin.json` 的 `version`，别人升级后才会看到新版本。

## 配置

在 Codex 的「安卓设备」右侧面板右上角点 **设置**，可直接在桌面端里改 adb 路径、无线调试、视频参数、数据目录、AAB 工作目录等；保存后写入用户配置文件并**立即热更新**，不需要重启 MCP 服务。

优先级：环境变量 > `%USERPROFILE%\.codex-android-tool\config.json` > 插件目录 `config.json` > 默认值。

也可以手动从 `config.example.json` 复制一份到 `%USERPROFILE%\.codex-android-tool\config.json`。

常用字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `adbPath` | 空 | 留空 = 随包 `scrcpy/adb.exe`（Windows） |
| `wirelessHost` | 空 | 无线调试设备 IP |
| `wirelessPort` | `5555` | adb connect 端口 |
| `autoConnect` | `false` | 启动时自动连接无线设备 |
| `videoMaxSize` | `720` | scrcpy 最大边 |
| `videoBitRate` | `2500000` | scrcpy 码率 |
| `dataDir` | 空 | 状态/日志目录；留空 = `%USERPROFILE%\.codex-android-tool\.android_tool` |
| `workspaceDir` | 空 | AAB 默认输出目录 |

环境变量：`CODEX_ANDROID_CONFIG`、`CODEX_ANDROID_ADB`、`CODEX_ANDROID_WIRELESS_HOST`、`CODEX_ANDROID_WIRELESS_PORT`、`CODEX_ANDROID_VIDEO_MAX_SIZE` 等，见 `server.mjs` 的 `ENV_MAP`。

## 开发与测试

```powershell
# 直接跑 MCP 握手
node server.mjs
# 然后往 stdin 写一行：
# {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
```

```powershell
node test/mcp-smoke.mjs                       # MCP 冒烟：握手 + 列工具 + android_state
node --test test/panel.test.mjs               # 面板：UI 资源、工具元数据、坐标映射、安全边界
node --test "..\..\..\DSH\dsh-android-tool\test\*.test.js"   # 复用原插件测试
```

## 结构

```text
codex-desktop-android-tool/
├─ .agents/plugins/marketplace.json  # 仓库根 marketplace 清单（source: "."）
├─ .codex-plugin/plugin.json   # Codex 插件清单
├─ mcp.json                    # 声明 stdio MCP server
├─ server.mjs                  # MCP 入口，注册 5 个模型工具 + android_panel
├─ ui/                         # MCP Apps 面板
│  ├─ panel.template.html      # 面板 UI（由 server 注入坐标映射源码）
│  └─ panel-math.mjs           # 坐标映射纯函数（与测试共用）
├─ skills/android-device/SKILL.md
├─ lib/                        # 从 dsh-android-tool 复用
├─ scrcpy/                     # adb.exe + scrcpy-server（Windows）
├─ tools/bundletool-all.jar
├─ node_modules/               # @yume-chan/scrcpy 等
├─ config.example.json
└─ README.md
```

## 安全边界

- 面板不启动本地 HTTP 服务、不开 WebSocket、不监听端口；设备操作全部经宿主 MCP 桥调用本插件已注册的有限工具（`android_panel` / `android_view` / `android_control`）。
- 面板 HTML 拒绝加载外部资源（CSP 的 `connectDomains` / `resourceDomains` / `frameDomains` 均为空）。
- 工具仍只作用于当前选中的设备；`android_adb` 是兜底工具，建议在 Codex 里把写操作工具设为需审批。
- 不记录令牌、密码或设备标识到日志；不需要新增环境变量或私钥。


## 已验证 / 未验证

已在 Windows 10 的 Codex 桌面版 `26.1103.3517.0`（codex-cli `0.167.0-alpha.3.2`）实测：

- 在 Codex 会话右侧 `+` → `更多工具…` → `android_panel` 能打开原生 MCP Apps 面板并渲染本插件 UI。
- `enable_mcp_apps` 开启后，MCP 资源 `resources/read`、`tools/call` 与面板初始化（`ui/initialize` / `ui/notifications/initialized`）均正常。
- 无设备时面板显示原因与恢复提示，不白屏。

未验证（需要真实设备/更多环境）：

- 两台真机同时在线时的选择切换、断线/离线/未授权/息屏、横竖屏旋转与四角点击的客户端实测。
- Logcat / 性能采样 / AAB→APK 面板在真实设备与大文件上的端到端实测（工具与前端已接好，自动化测试覆盖配置与协议）。
- macOS / Linux 客户端未测试（随包 adb 仅 Windows）。

## 已知限制

- 随包 `adb.exe` 是 Windows 版；macOS / Linux 需要在配置里指定自己的 adb。
- `android_control` 的 Unicode 输入和手柄摇杆/扳机需要 scrcpy control 通道；当前 `scrcpy-stream.js` 仍会同时开视频，Codex 场景下建议后续加 `video=false` 纯控制模式。
- 插件安装只拷贝文件，不会执行 `npm install`；本目录已自带 `node_modules`。
- 右侧面板依赖 Codex 桌面版的 MCP Apps；当前画面仍是截图刷新，实时视频尚未实现。面板不可用时先检查 `enable_mcp_apps` 是否启用、桌面版是否 ≥ 26.1103.3517.0。
- `android_adb` 能执行任意 adb 命令，建议在 Codex 里把写操作工具设为需审批。
