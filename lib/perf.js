/**
 * 性能采样：CPU / 内存 / GPU / 电池。
 *
 * GPU 没有 Android 统一接口，只能按 SoC 试探 sysfs；读不到就明确返回
 * `available:false`，绝不编造数字。
 */

import { setTimeout as delay } from 'node:timers/promises'

/** 解析 /proc/stat 第一行。 */
export function parseProcStat(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (!line.startsWith('cpu ')) continue
    const parts = line.trim().split(/\s+/u).slice(1).map(Number)
    if (parts.length < 4 || parts.some((item) => !Number.isFinite(item))) return undefined
    const idle = parts[3] + (parts[4] ?? 0)
    const total = parts.reduce((sum, value) => sum + value, 0)
    return { idle, total }
  }
  return undefined
}

/** 两次 /proc/stat 采样算 CPU 使用率。 */
export function computeCpuUsage(prev, curr) {
  if (prev === undefined || curr === undefined) return undefined
  const totalDelta = curr.total - prev.total
  const idleDelta = curr.idle - prev.idle
  if (totalDelta <= 0) return undefined
  const usage = 100 * (1 - idleDelta / totalDelta)
  return Math.max(0, Math.min(100, Math.round(usage * 10) / 10))
}

/** 解析 /proc/meminfo（KB）。 */
export function parseMeminfo(text) {
  const values = {}
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = /^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):\s+(\d+)/u.exec(line.trim())
    if (match !== null) values[match[1]] = Number(match[2])
  }
  const totalKb = values.MemTotal ?? 0
  const availableKb = values.MemAvailable ?? values.MemFree ?? 0
  return {
    totalKb,
    freeKb: values.MemFree ?? 0,
    availableKb,
    usedKb: Math.max(0, totalKb - availableKb),
    buffersKb: values.Buffers ?? 0,
    cachedKb: values.Cached ?? 0,
    swapTotalKb: values.SwapTotal ?? 0,
    swapFreeKb: values.SwapFree ?? 0,
  }
}

/** 从 dumpsys meminfo 里取应用总 PSS（KB）。 */
export function parseAppPss(text) {
  const source = String(text ?? '')
  const totalPss = /TOTAL PSS:\s*(\d+)/iu.exec(source)
  if (totalPss !== null) return Number(totalPss[1])
  const total = /^\s*TOTAL\s+(\d+)/imu.exec(source)
  if (total !== null) return Number(total[1])
  return undefined
}

/** 解析 dumpsys cpuinfo。 */
export function parseCpuInfo(text, pkg) {
  const source = String(text ?? '')
  let totalPercent
  const total = /^\s*([\d.]+)%\s+TOTAL:/imu.exec(source)
  if (total !== null) totalPercent = Number(total[1])

  let appPercent
  const target = String(pkg ?? '').trim()
  if (target.length > 0) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const pattern = new RegExp(`^\\s*([\\d.]+)%\\s+\\d+\\/${escaped}(?::|\\s)`, 'imu')
    const match = pattern.exec(source)
    if (match !== null) appPercent = Number(match[1])
  }
  return { totalPercent, appPercent }
}

/** 解析 dumpsys battery。 */
export function parseBattery(text) {
  const source = String(text ?? '')
  const level = /(?:^|\n)\s*level:\s*(\d+)/iu.exec(source)
  const status = /(?:^|\n)\s*status:\s*(\d+)/iu.exec(source)
  const temperature = /(?:^|\n)\s*temperature:\s*(-?\d+)/iu.exec(source)
  const statusText = {
    1: '未知',
    2: '充电中',
    3: '放电中',
    4: '未充电',
    5: '已充满',
  }
  const statusCode = status !== null ? Number(status[1]) : undefined
  return {
    level: level !== null ? Number(level[1]) : undefined,
    statusCode,
    status: statusCode !== undefined ? statusText[statusCode] ?? `状态 ${statusCode}` : undefined,
    temperatureC: temperature !== null ? Math.round(Number(temperature[1]) / 10) : undefined,
    charging: /AC powered:\s*true/iu.test(source) || /USB powered:\s*true/iu.test(source) || statusCode === 2,
  }
}

/** 解析 GPU sysfs 试探输出。 */
export function parseGpuOutput(text) {
  const sections = []
  let current
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const header = /^==(.+)$/u.exec(line.trim())
    if (header !== null) {
      current = { path: header[1], values: [] }
      sections.push(current)
      continue
    }
    if (current !== undefined && line.trim().length > 0) current.values.push(line.trim())
  }

  let usagePercent
  let clockMHz
  const raw = {}
  for (const section of sections) {
    const value = section.values[0]
    if (value === undefined) continue
    raw[section.path] = value
    if (section.path.includes('gpubusy')) {
      const parts = value.split(/\s+/u).map(Number)
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[1] > 0) {
        usagePercent = Math.round((parts[0] / parts[1]) * 1000) / 10
      }
    } else if (section.path.includes('utilisation') || section.path.includes('gpu_busy') || section.path.includes('busy')) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) {
        usagePercent = numeric > 100 ? Math.round((numeric / 100) * 10) / 10 : numeric
      }
    } else if (section.path.includes('gpuclk') || section.path.includes('cur_freq') || section.path.includes('clock')) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) clockMHz = Math.round(numeric > 1000000 ? numeric / 1000000 : numeric > 10000 ? numeric / 1000 : numeric)
    }
  }
  return { available: usagePercent !== undefined, usagePercent, clockMHz, raw }
}

/** 性能采样服务。 */
export class PerfService {
  /**
   * @param {object} options
   * @param {import('./adb.js').Adb} options.adb
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.adb = options.adb
    this.logger = options.logger
    this.cache = new Map()
  }

  /** 取一次性能快照（1 秒内复用）。 */
  async sample(serial, pkg) {
    const target = String(serial ?? '').trim()
    if (target.length === 0) return { ok: false, error: '没有选中设备。' }
    const wanted = String(pkg ?? '').trim()
    const key = `${target}|${wanted}`
    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < 1000) return cached.value

    const firstStat = await this.adb.shell(target, 'cat /proc/stat', { timeoutMs: 8000 })
    await delay(260)
    const secondStat = await this.adb.shell(target, 'cat /proc/stat', { timeoutMs: 8000 })
    const cpuUsage = computeCpuUsage(parseProcStat(firstStat.stdout), parseProcStat(secondStat.stdout))

    const meminfoResult = await this.adb.shell(target, 'cat /proc/meminfo', { timeoutMs: 8000 })
    const memory = parseMeminfo(meminfoResult.stdout)

    const cpuinfoResult = await this.adb.shell(target, 'dumpsys cpuinfo', { timeoutMs: 12000 })
    const cpuInfo = parseCpuInfo(cpuinfoResult.stdout, wanted)

    let appPssKb
    if (wanted.length > 0) {
      const appMem = await this.adb.shell(target, `dumpsys meminfo ${wanted}`, { timeoutMs: 12000 })
      appPssKb = parseAppPss(appMem.stdout)
    }

    const gpuCommand = [
      "for p in /sys/class/kgsl/kgsl-3d0/gpubusy /sys/class/kgsl/kgsl-3d0/gpuclk /sys/class/misc/mali0/device/utilisation /sys/kernel/gpu/gpu_busy /sys/class/devfreq/gpufreq/cur_freq; do echo \"==$p\"; cat \"$p\" 2>/dev/null; done",
      "echo '==prop.egl'",
      'getprop ro.hardware.egl',
      "echo '==prop.platform'",
      'getprop ro.board.platform',
    ].join('; ')
    const gpuResult = await this.adb.shell(target, gpuCommand, { timeoutMs: 12000 })
    const gpu = parseGpuOutput(gpuResult.stdout)
    const rendererMatch = /==prop\.egl\r?\n([^\r\n]+)/u.exec(gpuResult.stdout)
    const platformMatch = /==prop\.platform\r?\n([^\r\n]+)/u.exec(gpuResult.stdout)
    gpu.renderer = rendererMatch !== null ? rendererMatch[1].trim() : ''
    gpu.platform = platformMatch !== null ? platformMatch[1].trim() : ''
    if (gpu.available !== true) {
      gpu.reason = '设备没有暴露可读的 GPU 占用接口（不同 SoC 的 sysfs 不一样）。'
    }

    const batteryResult = await this.adb.shell(target, 'dumpsys battery', { timeoutMs: 8000 })
    const battery = parseBattery(batteryResult.stdout)

    const value = {
      ok: true,
      serial: target,
      package: wanted || undefined,
      cpu: {
        usagePercent: cpuUsage,
        appPercent: cpuInfo.appPercent,
        totalPercent: cpuInfo.totalPercent,
      },
      memory: {
        totalMb: Math.round(memory.totalKb / 1024),
        usedMb: Math.round(memory.usedKb / 1024),
        availableMb: Math.round(memory.availableKb / 1024),
        appPssMb: appPssKb === undefined ? undefined : Math.round(appPssKb / 1024),
      },
      gpu,
      battery,
      sampledAt: Date.now(),
    }
    this.cache.set(key, { at: Date.now(), value })
    return value
  }
}
