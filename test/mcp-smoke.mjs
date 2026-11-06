#!/usr/bin/env node
/** 最小 MCP 冒烟测试：起 server.mjs，握手，列工具，调一次 android_state。 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const child = spawn(process.execPath, [join(root, 'server.mjs')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
const pending = new Map()

rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 15000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
      else resolve(msg.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  })
  console.log('initialize ok:', init.serverInfo)
  console.log('instructions:', init.instructions)

  const list = await request(2, 'tools/list', {})
  console.log('tools:', list.tools.map((tool) => tool.name).join(', '))
  const names = list.tools.map((tool) => tool.name)
  for (const name of ['android_view', 'android_state', 'android_control', 'android_adb', 'android_aab2apk']) {
    if (!names.includes(name)) throw new Error(`missing original tool ${name}`)
  }
  if (!names.includes('android_panel')) throw new Error('missing android_panel tool')

  const state = await request(3, 'tools/call', { name: 'android_state', arguments: {} })
  console.log('android_state isError:', state.isError)
  console.log('android_state text:', state.content?.[0]?.text?.slice(0, 300))

  child.stdin.end()
  child.kill()
  console.log('SMOKE OK')
} catch (error) {
  console.error('SMOKE FAILED:', error.message)
  child.kill()
  process.exitCode = 1
}
