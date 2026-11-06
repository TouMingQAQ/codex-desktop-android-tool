#!/usr/bin/env node
/**
 * codex-desktop-android-tool 的 MCP stdio server。
 *
 * 复用 dsh-android-tool 的 lib/，把 android_view / android_state / android_control /
 * android_adb / android_aab2apk 五个工具以标准 MCP 暴露给 Codex / ChatGPT 桌面端。
 *
 * 约定：
 * - stdout 只写 JSON-RPC，一行一条；日志一律走 stderr。
 * - 截图以 MCP image content 返回（base64 PNG）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

import { DEFAULTS, snapshotConfig } from './lib/config.js'
import { AndroidService } from './lib/service.js'
import { buildTools } from './lib/tools.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SERVER_NAME = 'codex-desktop-android-tool'
const SERVER_VERSION = '0.1.0'
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

// ── 配置 ────────────────────────────────────────────────────────────────────

const CONFIG_FIELDS = [
  'adbPath',
  'scrcpyPath',
  'wirelessHost',
  'wirelessPort',
  'pairingPort',
  'autoConnect',
  'videoMaxSize',
  'videoBitRate',
  'videoFps',
  'videoEncoder',
  'videoCodecOptions',
  'previewFps',
  'logcatMaxLines',
  'adbTimeoutMs',
  'scrcpyExtraArgs',
]

const ENV_MAP = {
  CODEX_ANDROID_ADB: 'adbPath',
  CODEX_ANDROID_SCRCPY: 'scrcpyPath',
  CODEX_ANDROID_WIRELESS_HOST: 'wirelessHost',
  CODEX_ANDROID_WIRELESS_PORT: 'wirelessPort',
  CODEX_ANDROID_PAIRING_PORT: 'pairingPort',
  CODEX_ANDROID_AUTO_CONNECT: 'autoConnect',
  CODEX_ANDROID_VIDEO_MAX_SIZE: 'videoMaxSize',
  CODEX_ANDROID_VIDEO_BIT_RATE: 'videoBitRate',
  CODEX_ANDROID_VIDEO_FPS: 'videoFps',
  CODEX_ANDROID_VIDEO_ENCODER: 'videoEncoder',
  CODEX_ANDROID_VIDEO_CODEC_OPTIONS: 'videoCodecOptions',
  CODEX_ANDROID_PREVIEW_FPS: 'previewFps',
  CODEX_ANDROID_LOGCAT_MAX_LINES: 'logcatMaxLines',
  CODEX_ANDROID_ADB_TIMEOUT_MS: 'adbTimeoutMs',
  CODEX_ANDROID_SCRCPY_EXTRA_ARGS: 'scrcpyExtraArgs',
}

function readConfigFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    process.stderr.write(`[${SERVER_NAME}] 配置读取失败 ${path}: ${error instanceof Error ? error.message : String(error)}\n`)
    return {}
  }
}

function loadRawConfig() {
  const candidates = [
    process.env.CODEX_ANDROID_CONFIG,
    join(ROOT, 'config.json'),
    join(homedir(), '.codex-android-tool', 'config.json'),
  ].filter((path) => typeof path === 'string' && path.trim().length > 0)

  let merged = {}
  for (const path of candidates) {
    if (existsSync(path)) merged = { ...merged, ...readConfigFile(path) }
  }
  for (const [envName, field] of Object.entries(ENV_MAP)) {
    const value = process.env[envName]
    if (value !== undefined && value !== '') merged[field] = value
  }
  return merged
}

function createService() {
  const raw = loadRawConfig()
  const config = snapshotConfig(raw)
  const dataDir = String(raw.dataDir ?? process.env.CODEX_ANDROID_DATA_DIR ?? '').trim()
  const workspaceDir = String(raw.workspaceDir ?? '').trim()

  const logger = {
    info: (message) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`),
    warn: (message) => process.stderr.write(`[${SERVER_NAME}] warn: ${message}\n`),
    error: (message) => process.stderr.write(`[${SERVER_NAME}] error: ${message}\n`),
  }

  const ctx = {
    get(name) {
      if (name === 'workingDirectory' && workspaceDir.length > 0) {
        return { defaultDirectory: workspaceDir }
      }
      return undefined
    },
  }

  return new AndroidService({
    ctx,
    getConfig: () => config,
    pluginRoot: ROOT,
    getProfileDir: () => dataDir || join(homedir(), '.codex-android-tool'),
    logger,
  })
}

// ── 工具 ────────────────────────────────────────────────────────────────────

const service = createService()
const toolDefs = buildTools({ service })
const toolByName = new Map(toolDefs.map((tool) => [tool.name, tool]))

/** 递归转成可安全 JSON 化的值：丢 undefined / Buffer / 函数，NaN→null。 */
function sanitize(value) {
  if (value === undefined || value === null) return value ?? undefined
  if (Buffer.isBuffer(value)) return undefined
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'string' || type === 'boolean') return value
  if (type === 'bigint') return value.toString()
  if (type === 'function' || type === 'symbol') return undefined
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const cleaned = sanitize(item)
      if (cleaned !== undefined) out.push(cleaned)
    }
    return out
  }
  if (type === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const cleaned = sanitize(item)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  }
  return undefined
}

function toolResult(value, imageBuffer) {
  const clean = sanitize(value) ?? {}
  const isError = clean.ok === false
  const content = [{ type: 'text', text: JSON.stringify(clean, null, 2) }]
  if (Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
    content.push({ type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' })
  }
  return { content, isError }
}

async function captureFor(serial) {
  const shot = await service.screencapture({ serial, includeState: true, mark: false })
  if (shot.ok !== true) return { error: shot.error }
  return {
    buffer: shot.buffer,
    width: shot.width,
    height: shot.height,
    package: shot.package,
    activity: shot.activity,
    model: shot.model,
  }
}

const handlers = {
  async android_view(args = {}) {
    const result = await service.screencapture({
      serial: args.serial,
      savePath: args.savePath,
      includeState: args.includeState !== false,
      mark: true,
    })
    return toolResult(result, result.ok === true ? result.buffer : undefined)
  },

  async android_state(args = {}) {
    return toolResult(await service.deviceState({ serial: args.serial }))
  },

  async android_control(args = {}) {
    const isGamepad = args.action === 'gamepad'
    const wantCapture = isGamepad ? args.capture === true : args.capture !== false
    const result = await service.control({
      action: args.action,
      x: args.x,
      y: args.y,
      x2: args.x2,
      y2: args.y2,
      durationMs: args.durationMs,
      key: args.key,
      text: args.text,
      direction: args.direction,
      amount: args.amount,
      package: args.package,
      buttons: args.buttons,
      lstick: args.lstick,
      rstick: args.rstick,
      lt: args.lt,
      rt: args.rt,
      gamepadType: args.gamepadType,
      merge: args.merge,
      holdMs: args.holdMs,
      serial: args.serial,
      capture: false,
    })
    if (result.ok !== true || wantCapture !== true) return toolResult(result)
    const shot = await captureFor(result.serial ?? args.serial)
    if (shot.error !== undefined) {
      result.screenshotError = shot.error
      return toolResult(result)
    }
    Object.assign(result, {
      width: shot.width,
      height: shot.height,
      package: shot.package,
      activity: shot.activity,
      model: shot.model,
    })
    return toolResult(result, shot.buffer)
  },

  async android_adb(args = {}) {
    return toolResult(
      await service.adbCommand({
        command: args.command,
        mode: args.mode,
        serial: args.serial,
        timeoutMs: args.timeoutMs,
      }),
    )
  },

  async android_aab2apk(args = {}) {
    const overrides = stripUndefined({
      aabPath: args.aabPath,
      outputDir: args.outputDir,
      outputName: args.outputName,
      tempDir: args.tempDir,
      keystore: {
        keystorePath: args.keystorePath,
        keystorePassword: args.keystorePassword,
        keyAlias: args.keyAlias,
        keyPassword: args.keyPassword,
        storeType: args.storeType,
      },
      tools: {
        bundletoolJar: args.bundletoolJar,
        javaPath: args.javaPath,
        androidSdkRoot: args.androidSdkRoot,
        apksignerPath: args.apksignerPath,
        zipalignPath: args.zipalignPath,
      },
      align: args.align,
      verify: args.verify,
      alignment: args.alignment,
      overwrite: args.overwrite,
      keepIntermediate: args.keepIntermediate,
      cleanupTemp: args.cleanupTemp,
      extraBundletoolArgs: args.extraBundletoolArgs,
      extraApksignerArgs: args.extraApksignerArgs,
      javaOptions: args.javaOptions,
      manifestPath: args.manifestPath,
      deviceSpecPath: args.deviceSpecPath,
      bundletoolSigningConfig: args.bundletoolSigningConfig,
    })
    if (overrides.keystore !== undefined && Object.values(overrides.keystore).every((value) => value === undefined)) {
      delete overrides.keystore
    }
    if (overrides.tools !== undefined && Object.values(overrides.tools).every((value) => value === undefined)) {
      delete overrides.tools
    }
    return toolResult(await service.aab2apk.convert(overrides))
  },
}

function stripUndefined(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const cleaned = stripUndefined(item)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

const tools = toolDefs.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
}))

// ── MCP / JSON-RPC ──────────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const SERVER_INSTRUCTIONS = [
  'Android device control server (adb + scrcpy).',
  'Use android_view first to see the screen, then android_control to tap/swipe/type, then android_view again to verify.',
  'Coordinates are device-screen pixels. Prefer android_control over android_adb; android_adb is a last resort.',
  'Pass serial only when multiple devices are connected.',
].join(' ')

async function handle(message) {
  const { id, method, params } = message

  if (method === 'initialize') {
    const requested = params?.protocolVersion
    sendResult(id, {
      protocolVersion: typeof requested === 'string' && requested.length > 0 ? requested : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: SERVER_INSTRUCTIONS,
    })
    return
  }

  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') { sendResult(id, {}); return }

  if (method === 'tools/list') {
    sendResult(id, { tools })
    return
  }

  if (method === 'tools/call') {
    const name = params?.name
    const handler = typeof name === 'string' ? handlers[name] : undefined
    if (handler === undefined) {
      sendResult(id, {
        content: [{ type: 'text', text: `未知工具：${String(name ?? '')}` }],
        isError: true,
      })
      return
    }
    try {
      const result = await handler(params?.arguments ?? {})
      sendResult(id, result)
    } catch (error) {
      sendResult(id, {
        content: [{ type: 'text', text: `工具执行失败：${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      })
    }
    return
  }

  if (method === 'resources/list') {
    sendResult(id, { resources: [] })
    return
  }

  if (method === 'prompts/list') {
    sendResult(id, { prompts: [] })
    return
  }

  if (method?.startsWith?.('notifications/')) return
  sendError(id, -32601, `Method not found: ${String(method ?? '')}`)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const text = line.trim()
  if (text.length === 0) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  void handle(message).catch((error) => {
    if (message?.id !== undefined) {
      sendError(message.id, -32603, error instanceof Error ? error.message : String(error))
    }
  })
})

rl.on('close', () => {
  try { service.dispose() } catch { /* ignore */ }
  process.exit(0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { service.dispose() } catch { /* ignore */ }
    process.exit(0)
  })
}

void service.init().catch((error) => {
  process.stderr.write(`[${SERVER_NAME}] 初始化失败 ${error instanceof Error ? error.message : String(error)}\n`)
})

process.stderr.write(`[${SERVER_NAME}] MCP server ready (${tools.length} tools)\n`)
