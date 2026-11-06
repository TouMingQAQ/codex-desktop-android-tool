---
name: android-device
description: Control a connected Android device through the android_tool MCP server. Use when the user asks to look at an Android phone/emulator screen, tap/swipe/type on it, inspect device state, run adb, or convert an AAB to a signed APK.
metadata:
  short-description: Android device control
---

# Android device

Use the `android_tool` MCP server for Android work.

## Workflow

1. `android_view` — capture the current screen. Always do this before and after control actions.
2. `android_control` — tap / long_press / swipe / key / text / scroll / wake / open_app / gamepad.
3. `android_view` — verify the result.

Coordinates are device-screen pixels. If several devices are connected, pass `serial`.

## Tools

| Tool | Use |
|---|---|
| `android_view` | Screenshot + model/package/activity/resolution |
| `android_state` | Model, Android version, battery, WiFi, memory, storage, screen, foreground app |
| `android_control` | Touch, keys, text, scroll, open app, virtual gamepad |
| `android_adb` | Last resort, raw adb command |
| `android_aab2apk` | `.aab` → signed `.apk` (needs Java + Android SDK Build-Tools) |

## Rules

- Prefer `android_control` over `android_adb`.
- Do not invent device state; if `android_view` or `android_state` returns `ok: false`, report the error.
- `android_control` returns a screenshot by default. Pass `capture: false` when doing rapid repeated input.
- Text input is Unicode when the live scrcpy control channel is active; otherwise it falls back to `adb shell input` and only supports ASCII.
- Gamepad joysticks/triggers need the scrcpy control channel (UHID); otherwise only key taps work.

## Configuration

Config lives outside the plugin at `%USERPROFILE%\.codex-android-tool\config.json` (or `$CODEX_ANDROID_CONFIG`). If no `adbPath` is set, the bundled `scrcpy/adb.exe` is used on Windows.
