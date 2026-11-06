/**
 * 面板与设置页的 HTTP / WebSocket 接口（host 半边）。
 *
 * 前缀统一 `/x-android-tool`；WS 用精确 upgrade 路径。
 * 读接口在没设备时也返回 200 + 结构化原因，不让前端白屏。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browseDirectory } from './aab2apk.js'

/** 各路由完整路径。 */
export const WEB_ROUTES = {
  state: '/x-android-tool/state.json',
  screenshot: '/x-android-tool/screenshot.png',
  command: '/x-android-tool/command',
  pairQr: '/x-android-tool/pair/qr.png',
  logcat: '/x-android-tool/logcat.json',
  logcatExportText: '/x-android-tool/logcat/export.txt',
  logcatExport: '/x-android-tool/logcat/export',
  packages: '/x-android-tool/packages.json',
  perf: '/x-android-tool/perf.json',
  exec: '/x-android-tool/exec',
  videoWs: '/x-android-tool/video.ws',
  gamepadSvg: '/x-android-tool/gamepad.svg',
  aab2apkConfig: '/x-android-tool/aab2apk/config',
  aab2apkDetect: '/x-android-tool/aab2apk/detect',
  aab2apkConvert: '/x-android-tool/aab2apk/convert',
  aab2apkJob: '/x-android-tool/aab2apk/job',
  aab2apkCancel: '/x-android-tool/aab2apk/cancel',
  aab2apkBrowse: '/x-android-tool/aab2apk/browse',
}

const MAX_BODY_BYTES = 512 * 1024

/** 读 JSON 请求体。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/** 统一 JSON 响应。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 从 URLSearchParams 取过滤参数。 */
function filtersFrom(search) {
  return {
    serial: search.get('serial') ?? undefined,
    cursor: Number(search.get('cursor') ?? 0) || 0,
    pkg: search.get('pkg') ?? '',
    q: search.get('q') ?? '',
    level: search.get('level') ?? 'V',
    limit: Number(search.get('limit') ?? 0) || undefined,
  }
}

/**
 * 注册 HTTP 前缀路由与视频 WebSocket。
 * @param {object} webServer
 * @param {{service: import('./service.js').AndroidService, logger?: object}} source
 * @returns {() => void}
 */
export function registerWebRoutes(webServer, source) {
  const service = source.service

  const stopHttp = webServer.register({
    kind: 'prefix',
    path: '/x-android-tool',
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://x')
      const pathname = url.pathname
      const method = req.method ?? 'GET'
      const search = url.searchParams

      // 前端能带上当前会话时，先记下来，AAB→APK 的数据就会落到该会话的工作区。
      const sessionId = (search.get('session') ?? '').trim()
      if (sessionId.length > 0 && pathname.startsWith('/x-android-tool/aab2apk')) {
        service.noteSessionId?.(sessionId)
      }

      try {
        if (method === 'GET' && pathname === WEB_ROUTES.aab2apkConfig) {
          return sendJson(res, 200, await service.aab2apk.describe())
        }
        if (method === 'GET' && pathname === WEB_ROUTES.aab2apkDetect) {
          const config = await service.aab2apk.loadConfig()
          return sendJson(res, 200, { ok: true, ...service.aab2apk.detect(config) })
        }
        if (method === 'GET' && pathname === WEB_ROUTES.aab2apkJob) {
          const result = service.aab2apk.getJob(search.get('id') ?? '', Number(search.get('cursor') ?? 0) || 0)
          return sendJson(res, 200, result)
        }
        if (method === 'GET' && pathname === WEB_ROUTES.aab2apkBrowse) {
          const result = await browseDirectory(search.get('path') ?? '', service.aab2apk.baseDir())
          return sendJson(res, 200, result)
        }

        if ((method === 'GET' || method === 'HEAD') && pathname === WEB_ROUTES.gamepadSvg) {
          const requested = String(search.get('type') ?? '')
          const type = requested === 'ps' || requested === 'switch' ? requested : 'xbox'
          try {
            const svg = await readFile(join(service.pluginRoot, 'lib', `gamepad-${type}.svg`))
            res.statusCode = 200
            res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.setHeader('content-length', String(svg.length))
            res.end(method === 'HEAD' ? undefined : svg)
          } catch {
            res.statusCode = 404
            res.setHeader('cache-control', 'no-store')
            res.end('no gamepad asset')
          }
          return
        }

        if ((method === 'GET' || method === 'HEAD') && pathname === WEB_ROUTES.pairQr) {
          const png = service.qrPairingImage?.(search.get('token') ?? '')
          if (!Buffer.isBuffer(png)) {
            res.statusCode = 404
            res.setHeader('cache-control', 'no-store')
            res.end('no qr')
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'image/png')
          res.setHeader('content-length', String(png.length))
          res.setHeader('cache-control', 'no-store')
          res.end(method === 'HEAD' ? undefined : png)
          return
        }

        if ((method === 'GET' || method === 'HEAD') && pathname === WEB_ROUTES.state) {
          const state = await service.uiState()
          return sendJson(res, 200, state)
        }

        if ((method === 'GET' || method === 'HEAD') && pathname === WEB_ROUTES.screenshot) {
          const shot = await service.screenshotBuffer(search.get('serial') ?? undefined)
          if (shot.ok !== true || !Buffer.isBuffer(shot.buffer)) {
            res.statusCode = 404
            res.setHeader('cache-control', 'no-store')
            res.end(shot.error ?? 'no screenshot')
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'image/png')
          res.setHeader('content-length', String(shot.buffer.length))
          res.setHeader('cache-control', 'no-store')
          res.end(method === 'HEAD' ? undefined : shot.buffer)
          return
        }

        if (method === 'GET' && pathname === WEB_ROUTES.logcat) {
          const result = await service.logcatRead(filtersFrom(search))
          return sendJson(res, 200, result)
        }

        if (method === 'GET' && pathname === WEB_ROUTES.logcatExportText) {
          const filters = filtersFrom(search)
          const result = await service.exportLogcatText(filters)
          if (result.ok !== true) return sendJson(res, 200, { ok: false, error: result.error })
          const name = `logcat-${new Date().toISOString().replace(/[:.]/gu, '-')}.txt`
          res.statusCode = 200
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.setHeader('content-disposition', `attachment; filename="${name}"`)
          res.setHeader('cache-control', 'no-store')
          res.end(result.text)
          return
        }

        if (method === 'GET' && pathname === WEB_ROUTES.packages) {
          const result = await service.packages({ serial: search.get('serial') ?? undefined })
          return sendJson(res, 200, result)
        }

        if (method === 'GET' && pathname === WEB_ROUTES.perf) {
          const result = await service.perfSample({
            serial: search.get('serial') ?? undefined,
            pkg: search.get('pkg') ?? '',
          })
          return sendJson(res, 200, result)
        }

        if (method === 'GET' || method === 'HEAD') {
          return sendJson(res, 404, { ok: false, error: '未知路由' })
        }
        if (method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'GET, HEAD, POST')
          res.end()
          return
        }

        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }

        if (pathname === WEB_ROUTES.command) {
          const result = await service.humanCommand(body)
          return sendJson(res, 200, result)
        }
        if (pathname === WEB_ROUTES.aab2apkConfig) {
          try {
            await service.aab2apk.saveConfig(body.config ?? body)
            const described = await service.aab2apk.describe()
            return sendJson(res, 200, { ok: true, config: described.config })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (pathname === WEB_ROUTES.aab2apkConvert) {
          const result = await service.aab2apk.startJob(body.config ?? body ?? {})
          return sendJson(res, 200, result)
        }
        if (pathname === WEB_ROUTES.aab2apkCancel) {
          return sendJson(res, 200, service.aab2apk.cancel(body.id))
        }
        if (pathname === WEB_ROUTES.logcatExport) {
          const result = await service.exportLogcat(body)
          return sendJson(res, 200, result)
        }
        if (pathname === WEB_ROUTES.exec) {
          const result = await service.adbCommand(body)
          return sendJson(res, 200, result)
        }

        return sendJson(res, 404, { ok: false, error: '未知路由' })
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  const stopUpgrade = webServer.registerUpgrade({
    path: WEB_ROUTES.videoWs,
    handler(req, socket, head) {
      try {
        service.handleVideoUpgrade(req, socket, head)
      } catch (error) {
        try {
          socket.destroy()
        } catch {
          // 忽略
        }
        source.logger?.warn?.(`dsh-android-tool: video ws 失败 ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })

  return () => {
    stopUpgrade?.()
    stopHttp?.()
  }
}
