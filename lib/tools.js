/**
 * 面向模型的 Android 工具。
 *
 * 注册在 host 层（所有会话可见）。工具名用 snake_case，与 DSH 自带工具一致。
 * 所有工具只做参数校验并转给 AndroidService；失败返回结构化 { ok:false, error }。
 */

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    const image = value?.image
    if (image !== undefined && image !== null && typeof image.attachmentId === 'string') {
      blocks.push({ type: 'image', attachment: image })
    }
    return blocks
  },
}

/**
 * @param {object} deps
 * @param {import('./service.js').AndroidService} deps.service
 */
export function buildTools(deps) {
  const service = deps.service

  const view = {
    name: 'android_view',
    description: [
      'Capture the current screen of the selected Android device and return it as an image so you can see it.',
      'The screenshot is also pushed to the right-side "安卓设备" panel. Use it before/after any control action.',
      'Returns serial, model, current package/activity, width/height, capture time, and the image itself.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serial: { type: 'string', description: 'Optional device serial. Defaults to the selected device in settings.' },
        savePath: { type: 'string', description: 'Optional absolute path to also save the PNG to.' },
        includeState: { type: 'boolean', description: 'Include current model/package/activity in the result. Default true.' },
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    timeoutMs: 40000,
    async execute(args, exec) {
      service.noteAgent?.(exec?.agent)
      return service.screencapture({
        serial: args?.serial,
        savePath: args?.savePath,
        includeState: args?.includeState !== false,
        mark: true,
      })
    },
    presentCall() {
      return { card: 'generic', title: 'Android 截图', kind: 'read' }
    },
  }

  const state = {
    name: 'android_state',
    description: [
      'Query the selected Android device status: model, brand, Android version, battery (level/temperature/charging),',
      'WiFi (enabled/SSID/IP/airplane mode), memory, storage, screen size/density/wakefulness, and the current foreground app.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serial: { type: 'string', description: 'Optional device serial. Defaults to the selected device.' },
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    timeoutMs: 40000,
    async execute(args, exec) {
      service.noteAgent?.(exec?.agent)
      return service.deviceState({ serial: args?.serial })
    },
    presentCall() {
      return { card: 'generic', title: 'Android 设备状态', kind: 'read' }
    },
  }

  const control = {
    name: 'android_control',
    description: [
      'Simulate touch/key input on the selected Android device. When the live screen stream is running, it uses the',
      'low-latency scrcpy control channel (touch/key/text/scroll); otherwise it falls back to `adb shell input`. Actions:',
      '- tap: {x,y}; long_press: {x,y,durationMs}; swipe: {x1,y1,x2,y2,durationMs}',
      '- key: {key} (back/home/recents/enter/volume_up/volume_down/power/menu/wakeup or a numeric keycode)',
      '- text: {text} (scrcpy channel supports Unicode; adb fallback is ASCII only)',
      '- scroll: {direction: up|down|left|right, amount}; wake; open_app: {package}',
      '- gamepad: drive a virtual XBox 360 pad over scrcpy UHID. Fields: buttons (array of held buttons:',
      '  a,b,x,y,lb,rb,back,start,guide,lstick,rstick,up,down,left,right), lstick/rstick ({x,y} in -1..1,',
      '  y positive = up), lt/rt (0..1). Unspecified buttons are released. Set merge:true to overlay the previous',
      '  state instead. holdMs presses then releases after the given time (a quick tap); capture defaults to false.',
      '  gamepadType picks the virtual controller identity: xbox (default), ps, or switch.',
      'Coordinates are device-screen pixels; when using scrcpy they are scaled to video coordinates automatically.',
      'By default it captures a screenshot after the action and returns it as an image (capture:false to skip).',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['tap', 'long_press', 'swipe', 'key', 'text', 'scroll', 'wake', 'open_app', 'gamepad'],
          description: 'The input action.',
        },
        x: { type: 'number', description: 'Tap/long-press/swipe start X (device pixels).' },
        y: { type: 'number', description: 'Tap/long-press/swipe start Y (device pixels).' },
        x2: { type: 'number', description: 'Swipe end X.' },
        y2: { type: 'number', description: 'Swipe end Y.' },
        durationMs: { type: 'integer', description: 'Long-press / swipe duration in milliseconds.' },
        key: { type: 'string', description: 'Key name or numeric Android keycode.' },
        text: { type: 'string', description: 'ASCII text to type.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
        amount: { type: 'integer', description: 'Scroll distance in pixels.' },
        package: { type: 'string', description: 'Package name for open_app.' },
        buttons: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Gamepad: buttons to hold. Names: a,b,x,y,lb,rb,back,start,guide,lstick,rstick,up,down,left,right. Unlisted buttons are released.',
        },
        lstick: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          description: 'Gamepad: left stick, x/y in -1..1 (x right+, y up+).',
        },
        rstick: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          description: 'Gamepad: right stick, x/y in -1..1 (x right+, y up+).',
        },
        lt: { type: 'number', description: 'Gamepad: left trigger 0..1.' },
        rt: { type: 'number', description: 'Gamepad: right trigger 0..1.' },
        gamepadType: {
          type: 'string',
          enum: ['xbox', 'ps', 'switch'],
          description: 'Gamepad: virtual controller identity. xbox (default), ps (PlayStation), switch (Nintendo Switch).',
        },
        merge: { type: 'boolean', description: 'Gamepad: overlay on the previous state instead of replacing it. Default false.' },
        holdMs: { type: 'integer', description: 'Gamepad: hold the state for this many ms, then release all (a quick press).' },
        serial: { type: 'string', description: 'Optional device serial.' },
        capture: { type: 'boolean', description: 'Capture a screenshot after the action. Default true.' },
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    timeoutMs: 90000,
    async execute(args, exec) {
      service.noteAgent?.(exec?.agent)
      const isGamepad = args?.action === 'gamepad'
      return service.control({
        action: args?.action,
        x: args?.x,
        y: args?.y,
        x2: args?.x2,
        y2: args?.y2,
        durationMs: args?.durationMs,
        key: args?.key,
        text: args?.text,
        direction: args?.direction,
        amount: args?.amount,
        package: args?.package,
        buttons: args?.buttons,
        lstick: args?.lstick,
        rstick: args?.rstick,
        lt: args?.lt,
        rt: args?.rt,
        gamepadType: args?.gamepadType,
        merge: args?.merge,
        holdMs: args?.holdMs,
        serial: args?.serial,
        // 手柄是连续输入，默认不截图，避免每次点按都多 200ms。
        capture: isGamepad ? args?.capture === true : args?.capture !== false,
      })
    },
    presentCall(args) {
      return { card: 'generic', title: `Android ${String(args?.action ?? 'control')}`, kind: 'write' }
    },
  }

  const adb = {
    name: 'android_adb',
    description: [
      'Last-resort: run a raw adb command against the selected device using the plugin-configured adb.',
      'Prefer android_view / android_state / android_control for normal work; use this only when they cannot express it.',
      'mode=shell (default) runs `adb -s <serial> shell <command>`; mode=adb treats `command` as adb arguments.',
      'Returns exit code, stdout, stderr, elapsed time. Interactive commands are not supported and will time out.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Shell command (mode=shell) or adb argv (mode=adb).' },
        mode: { type: 'string', enum: ['shell', 'adb'], description: 'How to interpret command. Default shell.' },
        serial: { type: 'string', description: 'Optional device serial.' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 20000, max 120000).' },
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    timeoutMs: 130000,
    async execute(args, exec) {
      service.noteAgent?.(exec?.agent)
      return service.adbCommand({
        command: args?.command,
        mode: args?.mode,
        serial: args?.serial,
        timeoutMs: args?.timeoutMs,
      })
    },
    presentCall(args) {
      return { card: 'generic', title: `adb ${String(args?.command ?? '').slice(0, 40)}`, kind: 'write' }
    },
  }

  const aab2apk = {
    name: 'android_aab2apk',
    description: [
      'Convert an Android App Bundle (.aab) into a signed, installable .apk on this machine.',
      'Pipeline: bundletool build-apks --mode=universal → extract universal.apk → zipalign (optional) → apksigner sign → apksigner verify (optional).',
      'Needs Java, bundletool-all.jar and Android SDK Build-Tools (apksigner/zipalign); java/bundletool/SDK are auto-detected and each can be overridden.',
      'Keystore (path + password + alias) is required because the APK must be signed. Passwords are redacted from the returned log.',
      'Returns the output APK path, size, duration, package/version (when readable), verification flag and the tail of the tool output.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['aabPath', 'keystorePath', 'keystorePassword', 'keyAlias'],
      properties: {
        aabPath: { type: 'string', description: 'Absolute path of the .aab file to convert.' },
        outputDir: { type: 'string', description: 'Folder for the produced APK. Relative paths resolve against the target workspace.' },
        outputName: { type: 'string', description: 'Base name of the APK (without .apk). Empty = derived from the AAB file name.' },
        tempDir: { type: 'string', description: 'Scratch folder for bundletool temp files. Needs ~2-3x the AAB size. Empty = system temp.' },
        keystorePath: { type: 'string', description: 'Path of the signing keystore (.jks/.keystore/.p12/.pfx/.bks).' },
        keystorePassword: { type: 'string', description: 'Keystore (store) password.' },
        keyAlias: { type: 'string', description: 'Alias of the private key inside the keystore.' },
        keyPassword: { type: 'string', description: 'Key password. Empty = same as the keystore password.' },
        storeType: { type: 'string', enum: ['JKS', 'PKCS12', 'BKS'], description: 'Keystore type. Omit to auto-detect.' },
        bundletoolJar: { type: 'string', description: 'Path of bundletool-all.jar. Empty = auto-detect.' },
        javaPath: { type: 'string', description: 'java executable or JAVA_HOME directory. Empty = auto-detect.' },
        androidSdkRoot: { type: 'string', description: 'Android SDK root used to find apksigner/zipalign. Empty = auto-detect.' },
        apksignerPath: { type: 'string', description: 'apksigner(.bat/.exe) file or folder. Empty = auto-detect.' },
        zipalignPath: { type: 'string', description: 'zipalign file or folder. Empty = auto-detect.' },
        align: { type: 'boolean', description: 'Run zipalign before signing. Default true.' },
        verify: { type: 'boolean', description: 'Run apksigner verify after signing. Default true.' },
        alignment: { type: 'integer', description: 'zipalign byte alignment. Default 4.' },
        overwrite: { type: 'boolean', description: 'Overwrite an existing output file. Default true.' },
        keepIntermediate: { type: 'boolean', description: 'Keep the intermediate .apks archive. Default false.' },
        cleanupTemp: { type: 'boolean', description: 'Delete intermediate APKs/scratch folder afterwards. Default true.' },
        extraBundletoolArgs: { type: 'string', description: 'Extra bundletool build-apks arguments (whitespace separated).' },
        extraApksignerArgs: { type: 'string', description: 'Extra apksigner sign arguments (whitespace separated).' },
        javaOptions: { type: 'string', description: 'Extra JVM options for bundletool, e.g. -Xmx2g.' },
        manifestPath: { type: 'string', description: 'Optional explicit AndroidManifest.xml for bundletool.' },
        deviceSpecPath: { type: 'string', description: 'Optional device-spec.json.' },
        bundletoolSigningConfig: { type: 'string', description: 'Optional bundletool signing-config.json.' },
        timeoutMs: { type: 'integer', description: 'Overall timeout in milliseconds (default 1800000).' },
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    timeoutMs: 1800000,
    async execute(args, exec) {
      service.noteAgent?.(exec?.agent)
      const overrides = {
        aabPath: args?.aabPath,
        outputDir: args?.outputDir,
        outputName: args?.outputName,
        tempDir: args?.tempDir,
        keystore: {
          keystorePath: args?.keystorePath,
          keystorePassword: args?.keystorePassword,
          keyAlias: args?.keyAlias,
          keyPassword: args?.keyPassword,
          storeType: args?.storeType,
        },
        tools: {
          bundletoolJar: args?.bundletoolJar,
          javaPath: args?.javaPath,
          androidSdkRoot: args?.androidSdkRoot,
          apksignerPath: args?.apksignerPath,
          zipalignPath: args?.zipalignPath,
        },
        align: args?.align,
        verify: args?.verify,
        alignment: args?.alignment,
        overwrite: args?.overwrite,
        keepIntermediate: args?.keepIntermediate,
        cleanupTemp: args?.cleanupTemp,
        extraBundletoolArgs: args?.extraBundletoolArgs,
        extraApksignerArgs: args?.extraApksignerArgs,
        javaOptions: args?.javaOptions,
        manifestPath: args?.manifestPath,
        deviceSpecPath: args?.deviceSpecPath,
        bundletoolSigningConfig: args?.bundletoolSigningConfig,
      }
      // 去掉 undefined，让 mergeConfig 只覆盖用户真正给出的字段
      const compact = stripUndefined(overrides)
      if (compact.keystore !== undefined && Object.keys(compact.keystore).every((key) => compact.keystore[key] === undefined)) delete compact.keystore
      if (compact.tools !== undefined && Object.keys(compact.tools).every((key) => compact.tools[key] === undefined)) delete compact.tools
      return service.aab2apk.convert(compact)
    },
    presentCall(args) {
      return { card: 'generic', title: `AAB → APK ${String(args?.aabPath ?? '').split(/[\\/]/).pop() ?? ''}`.trim(), kind: 'write' }
    },
  }

  const list = [view, state, control, adb, aab2apk]
  // 工具返回值必须能被宿主无损序列化成 JSON：递归去掉 undefined / 非有限数字。
  for (const tool of list) {
    const execute = tool.execute
    tool.execute = async (args, exec) => cleanValue(await execute(args, exec))
  }
  return list
}

/** 递归清理成纯 JSON 值：去掉 undefined、把 NaN/Infinity 变成 null。 */
export function cleanValue(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'string') return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '\uFFFD')
  if (type === 'boolean') return value
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const cleaned = cleanValue(item)
      if (cleaned !== undefined) out.push(cleaned)
    }
    return out
  }
  if (type === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const cleaned = cleanValue(item)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  }
  return undefined
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
