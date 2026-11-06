/**
 * 独立 scrcpy 窗口：给需要 60fps 真实操作的人用。
 * 侧边栏的「打开 scrcpy 窗口」按钮走这里。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { splitArgs } from './config.js'

function killTree(child) {
  if (child === undefined || child === null || child.killed) return
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {})
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // 忽略
  }
}

export class ScrcpyWindow {
  /**
   * @param {object} options
   * @param {import('./adb.js').Adb} options.adb
   * @param {() => object} options.getConfig
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.adb = options.adb
    this.getConfig = options.getConfig
    this.logger = options.logger
    this.child = undefined
    this.serial = ''
    this.startedAt = 0
    this.lastError = ''
  }

  status() {
    return {
      running: this.child !== undefined && this.child.exitCode === null,
      serial: this.serial,
      startedAt: this.startedAt,
      error: this.lastError || undefined,
    }
  }

  /** 启动独立窗口。 */
  launch(serial) {
    const target = String(serial ?? '').trim()
    if (target.length === 0) return { ok: false, error: '没有选中设备。' }
    if (this.status().running) {
      return { ok: true, already: true, serial: this.serial }
    }
    const paths = this.adb.resolveScrcpy()
    if (!existsSync(paths.scrcpyPath)) {
      return { ok: false, error: `找不到 scrcpy：${paths.scrcpyPath}` }
    }
    const settings = this.getConfig()
    const args = ['-s', target, '--window-title', `Android - ${target}`, ...splitArgs(settings.scrcpyExtraArgs)]
    let child
    try {
      child = spawn(paths.scrcpyPath, args, { windowsHide: false, stdio: 'ignore' })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return { ok: false, error: this.lastError }
    }
    this.child = child
    this.serial = target
    this.startedAt = Date.now()
    this.lastError = ''
    child.on('error', (error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`dsh-android-tool: scrcpy 窗口启动失败 ${this.lastError}`)
    })
    child.on('exit', () => {
      if (this.child === child) {
        this.child = undefined
        this.serial = ''
      }
    })
    return { ok: true, serial: target, pid: child.pid }
  }

  /** 关闭独立窗口。 */
  stop() {
    if (this.child !== undefined) killTree(this.child)
    this.child = undefined
    this.serial = ''
    return { ok: true }
  }

  dispose() {
    this.stop()
  }
}
