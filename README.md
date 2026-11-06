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

## 安装

### 方式 1：本地 marketplace

marketplace 根目录里需要有 `.agents/plugins/marketplace.json`，且 `source` 指向的插件目录要在这个根目录内部（父目录/绝对路径会被忽略）。本仓库根目录的 `.agents/plugins/marketplace.json` 已按此配置好：

```powershell
codex plugin marketplace add "C:\WorkSpace\Work\Agent\Plugins\android-tool"
codex plugin add codex-desktop-android-tool@codex-work-plugins
```

安装产物落在 `%USERPROFILE%\.codex\plugins\cache\codex-work-plugins\codex-desktop-android-tool\0.1.0`，并自动启用。然后在 ChatGPT 桌面应用的 Codex 模式里开始新会话，输入 `@` 或 `$` 选择插件/技能。

### 方式 2：直接配 MCP server

```powershell
codex mcp add android-tool -- node "C:\WorkSpace\Work\Agent\Plugins\android-tool\codex-desktop-android-tool\server.mjs"
```

> Windows 上 `codex` 可能不在 PATH，CLI 实际位于 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，用完整路径调用即可。

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
codex plugin marketplace add <owner>/<repo>
codex plugin add codex-desktop-android-tool@codex-work-plugins
```

也可以给完整 URL、指定分支：

```powershell
codex plugin marketplace add https://github.com/<owner>/<repo> --ref main
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

优先级：环境变量 > `%USERPROFILE%\.codex-android-tool\config.json` > 插件目录 `config.json` > 默认值。

从 `config.example.json` 复制一份到 `%USERPROFILE%\.codex-android-tool\config.json`。

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
node --test "..\..\..\DSH\dsh-android-tool\test\*.test.js"   # 复用原插件测试
```

## 结构

```text
codex-desktop-android-tool/
├─ .codex-plugin/plugin.json   # Codex 插件清单
├─ mcp.json                    # 声明 stdio MCP server
├─ server.mjs                  # MCP 入口，注册 5 个工具
├─ skills/android-device/SKILL.md
├─ lib/                        # 从 dsh-android-tool 复用
├─ scrcpy/                     # adb.exe + scrcpy-server（Windows）
├─ tools/bundletool-all.jar
├─ node_modules/               # @yume-chan/scrcpy 等
├─ config.example.json
└─ README.md
```

## 已知限制

- 随包 `adb.exe` 是 Windows 版；macOS / Linux 需要在配置里指定自己的 adb。
- `android_control` 的 Unicode 输入和手柄摇杆/扳机需要 scrcpy control 通道；当前 `scrcpy-stream.js` 仍会同时开视频，Codex 场景下建议后续加 `video=false` 纯控制模式。
- 插件安装只拷贝文件，不会执行 `npm install`；本目录已自带 `node_modules`。
- 界面（设备画面 / Logcat / 性能 / 指令 / AAB→APK 五 Tab）尚未移植。下一步可做 MCP Apps 自定义 UI，在 ChatGPT 桌面端的对话旁渲染。
- `android_adb` 能执行任意 adb 命令，建议在 Codex 里把写操作工具设为需审批。
