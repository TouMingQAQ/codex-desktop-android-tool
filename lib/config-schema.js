/**
 * dsh-android-tool 的 Config schema。
 *
 * 每个字段都过 `volatile()`：DSH 设置页只允许写 volatile 字段，volatile 更新走
 * `loader/volatile-update`、就地提交、不重挂插件，所以 apply() 只跑一次；
 * 业务代码每次用时都要读实时值（见 config.js: snapshotConfig）。
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from './config.js'

/** 把 schema 标记为 volatile（老版本 schemastery 没有就退化）。 */
function live(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}

export const Config = z.object({
  adbPath: live(
    z
      .string()
      .default(DEFAULTS.adbPath)
      .description('adb 可执行文件路径。留空 = 使用本插件 scrcpy 目录里的 adb.exe。'),
  ),
  scrcpyPath: live(
    z
      .string()
      .default(DEFAULTS.scrcpyPath)
      .description('scrcpy 可执行文件路径。精简包默认不含 scrcpy.exe；如果需要「打开 scrcpy 窗口」，请填本机 scrcpy.exe 的路径。'),
  ),
  wirelessHost: live(z.string().default(DEFAULTS.wirelessHost).description('无线调试的设备 IP，例如 192.168.1.23。留空 = 未配置。')),
  wirelessPort: live(z.number().step(1).min(1).max(65535).default(DEFAULTS.wirelessPort).description('adb connect 使用的端口，Android 无线调试通常是 5555 或系统给出的端口。')),
  pairingPort: live(z.number().step(1).min(0).max(65535).default(DEFAULTS.pairingPort).description('Android 11+ 无线调试配对端口。0 = 未设置；配对码只用于一次配对，不保存。')),
  autoConnect: live(z.boolean().default(DEFAULTS.autoConnect).description('插件加载后自动 adb connect 配置的无线设备。')),
  videoMaxSize: live(z.number().step(1).min(320).max(4096).default(DEFAULTS.videoMaxSize).description('scrcpy 画面最大边长（像素）。越小越省带宽。')),
  videoBitRate: live(z.number().step(100000).min(100000).max(50000000).default(DEFAULTS.videoBitRate).description('scrcpy 视频码率（bit/s）。默认 4 Mbps。')),
  videoFps: live(z.number().step(1).min(1).max(120).default(DEFAULTS.videoFps).description('scrcpy 最大帧率。')),
  videoEncoder: live(
    z
      .string()
      .default(DEFAULTS.videoEncoder)
      .description('指定 scrcpy 视频编码器（MediaCodec 名字）。留空 = 自动。小米/MIUI 卡顿时可填设备的硬件编码器名。'),
  ),
  videoCodecOptions: live(
    z
      .string()
      .default(DEFAULTS.videoCodecOptions)
      .description('scrcpy video_codec_options，例如 i-frame-interval:float=1（关键帧间隔降到 1 秒，弱网/卡顿更快恢复）。留空 = scrcpy 默认。'),
  ),
  previewFps: live(z.number().step(1).min(1).max(10).default(DEFAULTS.previewFps).description('WebCodecs 不可用时的截图轮询帧率（1–10）。')),
  logcatMaxLines: live(z.number().step(100).min(100).max(100000).default(DEFAULTS.logcatMaxLines).description('服务端 logcat 环形缓冲最大行数。')),
  adbTimeoutMs: live(z.number().step(500).min(1000).max(120000).default(DEFAULTS.adbTimeoutMs).description('单次 adb 命令默认超时（毫秒）。')),
  scrcpyExtraArgs: live(z.string().default(DEFAULTS.scrcpyExtraArgs).description('追加给独立 scrcpy 窗口的启动参数（空格分隔，高级用户使用）。')),
})
