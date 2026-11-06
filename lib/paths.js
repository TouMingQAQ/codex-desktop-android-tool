/**
 * 路径布局：插件根目录、数据目录、日志导出目录。
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 从入口 import.meta.url 取插件根目录。 */
export function pluginRootFrom(importMetaUrl) {
  return fileURLToPath(new URL('.', importMetaUrl))
}

/** 数据根目录下各文件/目录的布局。 */
export function layoutAt(root) {
  return {
    root,
    stateFile: join(root, 'state.json'),
    logsDir: join(root, 'logs'),
  }
}
