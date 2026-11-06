#!/usr/bin/env node
/**
 * MCP Apps 面板测试：
 * - MCP 握手 / tools/list / resources/list / resources/read
 * - android_panel 工具元数据与返回
 * - 面板 HTML 的安全边界（无本地 HTTP/WebSocket）
 * - 坐标映射（与面板共用 ui/panel-math.mjs）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { clamp, containRect, mapContainPoint, isTap, clampDevicePoint } from '../ui/panel-math.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  })
  const pending = new Map()
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      waiter(msg)
    }
  })
  let nextId = 1
  function request(method, params, timeoutMs = 20000) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
        else resolve(msg.result)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  return { child, request, stop: () => { try { child.stdin.end() } catch {}; try { child.kill() } catch {} } }
}

test('MCP 握手、5 个原工具保留、android_panel 带 thread UI 元数据', async () => {
  const srv = startServer()
  try {
    const init = await srv.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'panel-test', version: '0.0.0' },
    })
    assert.equal(init.serverInfo.name, 'codex-desktop-android-tool')
    assert.equal(init.capabilities.resources.listChanged, false)

    const list = await srv.request('tools/list', {})
    const names = list.tools.map((tool) => tool.name)
    for (const name of ['android_view', 'android_state', 'android_control', 'android_adb', 'android_aab2apk']) {
      assert.ok(names.includes(name), `missing original tool ${name}`)
    }
    assert.ok(names.includes('android_panel'))

    const panel = list.tools.find((tool) => tool.name === 'android_panel')
    assert.equal(panel.title, '安卓设备')
    assert.equal(panel._meta.ui.resourceUri, 'ui://android-tool/panel.html')
    assert.deepEqual(panel._meta['openai/ui'].entrypoints, [{ type: 'thread' }])
    assert.equal(panel._meta['openai/ui'].preferredModelDisplayMode, 'inline')
    assert.ok(panel.inputSchema.properties.config, 'android_panel 应支持 config 参数')
    assert.ok(panel.inputSchema.properties.q, 'android_panel 应支持 logcat 关键字参数')
    assert.ok(panel.inputSchema.properties.pkg, 'android_panel 应支持 logcat 包名参数')
    assert.deepEqual(panel.inputSchema.properties.action.enum, ['state', 'select', 'refreshDevices', 'getConfig', 'saveConfig', 'logcatStart', 'logcatStop', 'logcatRead', 'exportLogcat', 'perfSample', 'qrPairStart', 'qrPairStatus', 'qrPairCancel', 'qrPairImage', 'pair', 'connect', 'disconnect', 'startVideo', 'stopVideo', 'videoInfo', 'startScrcpy', 'stopScrcpy'])

    const view = list.tools.find((tool) => tool.name === 'android_view')
    assert.ok(!/pushed to the right-side/i.test(view.description), 'android_view 不应再宣称自动推送到面板')
  } finally {
    srv.stop()
  }
})

test('resources/list 与 resources/read 返回 MCP App HTML', async () => {
  const srv = startServer()
  try {
    await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    const list = await srv.request('resources/list', {})
    assert.equal(list.resources.length, 1)
    const resource = list.resources[0]
    assert.equal(resource.uri, 'ui://android-tool/panel.html')
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app')
    assert.deepEqual(resource._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen'])

    const read = await srv.request('resources/read', { uri: resource.uri })
    const content = read.contents[0]
    assert.equal(content.uri, resource.uri)
    assert.equal(content.mimeType, 'text/html;profile=mcp-app')
    assert.ok(content.text.includes('<title>安卓设备</title>'))
    assert.ok(content.text.includes('function mapContainPoint'), '面板应内联坐标映射源码')
    assert.ok(content.text.includes('Logcat') && content.text.includes('性能') && content.text.includes('AAB→APK'), '面板应包含 Logcat / 性能 / AAB 标签')
    assert.ok(content.text.includes('data-tab="settings"'), '设置应是独立 Tab')
    assert.ok(content.text.includes('扫码配对') && content.text.includes('配对码配对') && content.text.includes('IP 直连'), '应保留无线配对入口')
    assert.ok(content.text.includes('qrPairStart') && content.text.includes('qrPairImage'), '扫码配对应走宿主工具桥')
    assert.ok(content.text.includes('logcatPkg') && content.text.includes('logcatKeyword'), 'Logcat 应有包名和关键字筛选输入')
    assert.ok(content.text.includes('id="videoCanvas"') && content.text.includes('id="btnLive"'), '面板应包含实时视频 canvas 和按钮')
    assert.ok(content.text.includes('id="gamepadOverlay"') && content.text.includes('data-gp="a"'), '面板应包含手柄 UI')

    // 面板默认走宿主 tools/call；实时视频允许回环 WebSocket，但不能用 fetch/XHR。
    assert.ok(!/\bfetch\s*\(/.test(content.text), '面板不应使用 fetch')
    assert.ok(!/XMLHttpRequest/.test(content.text), '面板不应使用 XMLHttpRequest')
    assert.ok(/new\s+WebSocket\s*\(/.test(content.text), '实时视频应使用 WebSocket')
    assert.ok(content.text.includes("addEventListener('pagehide'"), '面板应在关闭时清理计时器/请求')
    assert.ok(content.text.includes("addEventListener('message'"), '面板应只听宿主 postMessage')
    assert.ok(content.text.includes('ui/initialize'), '面板应实现 MCP Apps 的 ui/initialize')
    assert.ok(content.text.includes('ui/notifications/initialized'), '面板应发送 ui/notifications/initialized')
  } finally {
    srv.stop()
  }
})

test('resources/read 拒绝未知 URI', async () => {
  const srv = startServer()
  try {
    await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    await assert.rejects(
      srv.request('resources/read', { uri: 'ui://android-tool/../../secret' }),
      /Unknown resource|unknown resource/i,
    )
  } finally {
    srv.stop()
  }
})

test('android_panel state 返回设备列表结构', async () => {
  const srv = startServer()
  try {
    await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    // Codex 打开 thread entrypoint 时会先用空参数调用一次工具，必须默认返回 state。
    const empty = await srv.request('tools/call', { name: 'android_panel', arguments: {} }, 30000)
    assert.equal(empty.isError, false)
    const emptyPayload = JSON.parse(empty.content[0].text)
    assert.equal(emptyPayload.ok, true)
    const result = await srv.request('tools/call', { name: 'android_panel', arguments: { action: 'state' } }, 30000)
    assert.equal(result.isError, false)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.devices))
    assert.equal(typeof payload.selectedSerial, 'string')
    assert.ok(payload.stream && typeof payload.stream === 'object')
  } finally {
    srv.stop()
  }
})

test('android_panel getConfig / saveConfig 写入用户配置并热更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'android-tool-config-'))
  const configPath = join(dir, 'config.json')
  const srv = startServer({ CODEX_ANDROID_CONFIG: configPath })
  try {
    await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })

    const got = await srv.request('tools/call', { name: 'android_panel', arguments: { action: 'getConfig' } }, 20000)
    const gotPayload = JSON.parse(got.content[0].text)
    assert.equal(gotPayload.ok, true)
    assert.equal(gotPayload.configPath, configPath)
    assert.equal(typeof gotPayload.config, 'object')

    const saved = await srv.request('tools/call', {
      name: 'android_panel',
      arguments: {
        action: 'saveConfig',
        config: { wirelessPort: 6000, videoMaxSize: 800, autoConnect: true, adbPath: '', dataDir: '' },
      },
    }, 20000)
    const savedPayload = JSON.parse(saved.content[0].text)
    assert.equal(savedPayload.ok, true)
    assert.equal(savedPayload.config.wirelessPort, 6000)
    assert.equal(savedPayload.config.videoMaxSize, 800)
    assert.equal(savedPayload.config.autoConnect, true)

    assert.ok(existsSync(configPath))
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.wirelessPort, 6000)
    assert.equal(written.videoMaxSize, 800)
    assert.equal(written.autoConnect, true)
    assert.equal(Object.prototype.hasOwnProperty.call(written, 'adbPath'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(written, 'dataDir'), false)
  } finally {
    srv.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('android_panel 扫码配对：生成二维码、查询、取消', async () => {
  const srv = startServer()
  try {
    await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    const start = await srv.request('tools/call', { name: 'android_panel', arguments: { action: 'qrPairStart' } }, 30000)
    const startPayload = JSON.parse(start.content[0].text)
    assert.equal(startPayload.ok, true)
    assert.ok(typeof startPayload.token === 'string' && startPayload.token.length > 0)

    const status = await srv.request('tools/call', { name: 'android_panel', arguments: { action: 'qrPairStatus', token: startPayload.token } }, 15000)
    const statusPayload = JSON.parse(status.content[0].text)
    assert.equal(statusPayload.ok, true)
    assert.ok(['waiting', 'pairing', 'connecting'].includes(statusPayload.status))

    const image = await srv.request('tools/call', { name: 'android_panel', arguments: { action: 'qrPairImage', token: startPayload.token } }, 15000)
    const imageItem = image.content.find((item) => item.type === 'image')
    assert.ok(imageItem && imageItem.data.length > 100, 'qrPairImage 应返回 PNG')

    const cancel = await srv.request('tools/call', { name: 'android_panel', arguments: { action: 'qrPairCancel', token: startPayload.token } }, 15000)
    const cancelPayload = JSON.parse(cancel.content[0].text)
    assert.equal(cancelPayload.ok, true)
  } finally {
    srv.stop()
  }
})

test('android_panel videoInfo 返回回环 WebSocket 地址和端口', async () => {
  const srv = startServer()
  try {
    await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    const result = await srv.request('tools/call', { name: 'android_panel', arguments: { action: 'videoInfo' } }, 15000)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.ok, true)
    assert.match(payload.url, /^ws:\/\/127\.0\.0\.1:\d+\/video\?token=[0-9a-f]+$/)
    assert.ok(payload.port > 0)
  } finally {
    srv.stop()
  }
})

test('坐标映射：contain 留边、四角、越界取消', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(99, 0, 10), 10)

  // 竖屏 1080x1920 放进 200x400 的盒子：上下留边。
  const rect = { left: 10, top: 20, width: 200, height: 400 }
  const box = containRect(rect, 1080, 1920)
  assert.equal(box.drawWidth, 200)
  assert.ok(Math.abs(box.drawHeight - 355.5555) < 0.01)
  assert.equal(box.offsetX, 10)
  assert.ok(Math.abs(box.offsetY - 42.2222) < 0.01)

  // 正中心 -> 540, 960
  const center = mapContainPoint({ clientX: 110, clientY: 220, rect, imageWidth: 1080, imageHeight: 1920 })
  assert.equal(center.x, 540)
  assert.equal(center.y, 960)

  // 四角内边缘
  const topLeft = mapContainPoint({ clientX: box.offsetX, clientY: box.offsetY, rect, imageWidth: 1080, imageHeight: 1920 })
  assert.equal(topLeft.x, 0)
  assert.equal(topLeft.y, 0)
  const bottomRight = mapContainPoint({ clientX: box.offsetX + box.drawWidth - 0.01, clientY: box.offsetY + box.drawHeight - 0.01, rect, imageWidth: 1080, imageHeight: 1920 })
  assert.equal(bottomRight.x, 1079)
  assert.equal(bottomRight.y, 1919)

  // 留边区域（图片上方）不接受输入
  assert.equal(mapContainPoint({ clientX: 110, clientY: 10, rect, imageWidth: 1080, imageHeight: 1920 }), null)

  // 横屏 1920x1080 放进 400x200：左右留边，左边 20px 无效
  const land = { left: 0, top: 0, width: 400, height: 200 }
  const landBox = containRect(land, 1920, 1080)
  assert.ok(Math.abs(landBox.offsetX - 22.2222) < 0.01)
  assert.equal(mapContainPoint({ clientX: 5, clientY: 100, rect: land, imageWidth: 1920, imageHeight: 1080 }), null)
  const landCenter = mapContainPoint({ clientX: 200, clientY: 100, rect: land, imageWidth: 1920, imageHeight: 1080 })
  assert.equal(landCenter.x, 960)
  assert.equal(landCenter.y, 540)

  // 边界裁剪
  const clamped = clampDevicePoint({ x: -50, y: 99999 }, 1080, 1920)
  assert.deepEqual(clamped, { x: 0, y: 1919 })

  // 点击 vs 滑动
  assert.equal(isTap({ clientX: 10, clientY: 10 }, { clientX: 16, clientY: 14 }), true)
  assert.equal(isTap({ clientX: 10, clientY: 10 }, { clientX: 40, clientY: 10 }), false)
})
