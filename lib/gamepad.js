/**
 * 手柄（gamepad）输入模型 —— 纯函数，方便单测。
 *
 * 设备侧走 scrcpy 的 UHID：向 scrcpy-server 发 UHID_CREATE（一个 XBox 360 手柄的
 * HID 报告描述符），之后每次输入发一条 15 字节的 UHID_INPUT 报告。
 * 报告格式与描述符取自 scrcpy 的 app/src/hid/hid_gamepad.c，保证 Android
 * InputReader 能识别成标准手柄。
 *
 * 归一化后的状态（host、WebSocket、界面、AI 工具共用同一份结构）：
 *   {
 *     buttons: { a,b,x,y,lb,rb,back,start,guide,lstick,rstick,up,down,left,right: boolean },
 *     lstick: { x, y },   // -1..1，x 右为正，y 上为正
 *     rstick: { x, y },
 *     lt: 0..1,
 *     rt: 0..1,
 *   }
 */

/** 手柄支持的全部按键（归一化名）。 */
export const GAMEPAD_BUTTON_NAMES = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'back',
  'start',
  'guide',
  'lstick',
  'rstick',
  'up',
  'down',
  'left',
  'right',
]

/** 名字别名 → 归一化名（兼容 Xbox / PlayStation / SDL 叫法）。 */
const BUTTON_ALIASES = {
  south: 'a',
  cross: 'a',
  east: 'b',
  circle: 'b',
  west: 'x',
  square: 'x',
  north: 'y',
  triangle: 'y',
  l1: 'lb',
  shoulder_left: 'lb',
  left_shoulder: 'lb',
  r1: 'rb',
  shoulder_right: 'rb',
  right_shoulder: 'rb',
  select: 'back',
  back_button: 'back',
  menu: 'start',
  start_button: 'start',
  mode: 'guide',
  home: 'guide',
  ps: 'guide',
  l3: 'lstick',
  left_stick: 'lstick',
  click_left: 'lstick',
  r3: 'rstick',
  right_stick: 'rstick',
  click_right: 'rstick',
  dpad_up: 'up',
  dpad_down: 'down',
  dpad_left: 'left',
  dpad_right: 'right',
  up_arrow: 'up',
  down_arrow: 'down',
  left_arrow: 'left',
  right_arrow: 'right',
}

/** 归一化名 → 16 位按钮位（对应 scrcpy hid_gamepad.c 的 sc_hid_gamepad_get_button_id）。 */
const HID_BUTTON_BITS = {
  a: 0x0001, // SOUTH / 下
  b: 0x0002, // EAST / 右
  x: 0x0008, // WEST / 左
  y: 0x0010, // NORTH / 上
  lb: 0x0040, // LEFT_SHOULDER
  rb: 0x0080, // RIGHT_SHOULDER
  back: 0x0400,
  start: 0x0800,
  guide: 0x1000,
  lstick: 0x2000,
  rstick: 0x4000,
}

/**
 * 手柄类型。三种都用同一份通用 HID 报告描述符，只改 UHID 的 VID/PID/名字，
 * 以及 A/B/X/Y 四个按键的位映射（NS 的 A 在右、B 在下）。
 */
export const GAMEPAD_TYPES = {
  xbox: {
    id: 'xbox',
    label: 'XBox',
    vendorId: 0x045e,
    productId: 0x028e,
    name: 'Microsoft X-Box 360 Pad',
    bits: { a: 0x0001, b: 0x0002, x: 0x0008, y: 0x0010 },
  },
  ps: {
    id: 'ps',
    label: 'PlayStation',
    vendorId: 0x054c,
    productId: 0x0ce6,
    name: 'DualSense Wireless Controller',
    bits: { a: 0x0001, b: 0x0002, x: 0x0008, y: 0x0010 },
  },
  switch: {
    id: 'switch',
    label: 'Nintendo Switch',
    vendorId: 0x057e,
    productId: 0x2009,
    name: 'Pro Controller',
    // 面板按位置把 A 放右、B 放下、X 放上、Y 放左；位映射与标准一致（A→BUTTON_A …）。
    bits: { a: 0x0001, b: 0x0002, x: 0x0008, y: 0x0010 },
  },
}

/** 手柄类型别名。 */
const TYPE_ALIASES = {
  xbox: 'xbox',
  xbox360: 'xbox',
  'xbox-360': 'xbox',
  xb: 'xbox',
  ps: 'ps',
  playstation: 'ps',
  ps4: 'ps',
  ps5: 'ps',
  dualshock: 'ps',
  dualsense: 'ps',
  switch: 'switch',
  ns: 'switch',
  nintendo: 'switch',
  nintendo_switch: 'switch',
  nintendoswitch: 'switch',
  'nintendo switch': 'switch',
  procontroller: 'switch',
}

/** 把外部类型字符串归一化成 xbox / ps / switch。认不出回退 xbox。 */
export function resolveGamepadType(type) {
  const key = String(type ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_')
  return TYPE_ALIASES[key] ?? TYPE_ALIASES[key.replace(/_/gu, '')] ?? 'xbox'
}

/** 取手柄类型定义。 */
export function gamepadTypeInfo(type) {
  return GAMEPAD_TYPES[resolveGamepadType(type)]
}

/** 方向键在 scrcpy 里走 hat switch，不进按钮位。 */
const DPAD_BITS = {
  up: 0x10000,
  down: 0x20000,
  left: 0x40000,
  right: 0x80000,
}

/** 回退到 adb keyevent 时用的 Android keycode（按住语义做不到，只能点按）。 */
export const GAMEPAD_KEYCODE_FALLBACK = {
  a: 96, // KEYCODE_BUTTON_A
  b: 97, // KEYCODE_BUTTON_B
  x: 99, // KEYCODE_BUTTON_X
  y: 100, // KEYCODE_BUTTON_Y
  lb: 102, // KEYCODE_BUTTON_L1
  rb: 103, // KEYCODE_BUTTON_R1
  lt: 104, // KEYCODE_BUTTON_L2
  rt: 105, // KEYCODE_BUTTON_R2
  lstick: 106, // KEYCODE_BUTTON_THUMBL
  rstick: 107, // KEYCODE_BUTTON_THUMBR
  start: 108, // KEYCODE_BUTTON_START
  back: 109, // KEYCODE_BUTTON_SELECT
  guide: 110, // KEYCODE_BUTTON_MODE
  up: 19, // KEYCODE_DPAD_UP
  down: 20, // KEYCODE_DPAD_DOWN
  left: 21, // KEYCODE_DPAD_LEFT
  right: 22, // KEYCODE_DPAD_RIGHT
}

/**
 * XBox 360 手柄 HID 报告描述符（与 scrcpy 一致）。
 * 4 个 16 位摇杆轴 + 2 个 16 位扳机 + 16 位按钮 + 4 位 hat。
 */
export const GAMEPAD_HID_REPORT_DESC = Uint8Array.from([
  // Usage Page (Generic Desktop), Usage (Gamepad), Collection (Application)
  0x05, 0x01,
  0x09, 0x05,
  0xa1, 0x01,
  // Collection (Physical)
  0xa1, 0x00,
  // Usage X / Y / Rx / Ry
  0x05, 0x01,
  0x09, 0x30,
  0x09, 0x31,
  0x09, 0x33,
  0x09, 0x34,
  // Logical Min 0, Logical Max 65535
  0x15, 0x00,
  0x27, 0xff, 0xff, 0x00, 0x00,
  // Report Size 16, Report Count 4, Input (Data,Var,Abs)
  0x75, 0x10,
  0x95, 0x04,
  0x81, 0x02,
  // Usage Z / Rz (triggers)
  0x05, 0x01,
  0x09, 0x32,
  0x09, 0x35,
  // Logical Min 0, Logical Max 32767
  0x15, 0x00,
  0x26, 0xff, 0x7f,
  // Report Size 16, Report Count 2, Input (Data,Var,Abs)
  0x75, 0x10,
  0x95, 0x02,
  0x81, 0x02,
  // Usage Page (Buttons), Usage Min 1, Max 16
  0x05, 0x09,
  0x19, 0x01,
  0x29, 0x10,
  // Logical Min 0, Max 1, Report Count 16, Size 1
  0x15, 0x00,
  0x25, 0x01,
  0x95, 0x10,
  0x75, 0x01,
  0x81, 0x02,
  // Usage Page (Generic Desktop), Usage (Hat switch)
  0x05, 0x01,
  0x09, 0x39,
  // Logical Min 1, Max 8, Size 4, Count 1, Input (Data,Var,Abs,Null)
  0x15, 0x01,
  0x25, 0x08,
  0x75, 0x04,
  0x95, 0x01,
  0x81, 0x42,
  // End Collection x2
  0xc0,
  0xc0,
])

/** 手柄 HID 报告的字节数。 */
export const GAMEPAD_REPORT_SIZE = 15

/** 手柄 HID 设备 id（scrcpy 的 gamepad 槽位从 3 起，这里只建一个手柄，用 3 更贴近官方实现）。 */
export const GAMEPAD_HID_ID = 3

/** 一个空手柄状态。 */
export function emptyGamepadState() {
  const buttons = {}
  for (const name of GAMEPAD_BUTTON_NAMES) buttons[name] = false
  return { buttons, lstick: { x: 0, y: 0 }, rstick: { x: 0, y: 0 }, lt: 0, rt: 0 }
}

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(min, Math.min(max, number))
}

function clampAxis(value) {
  return clamp(value, -1, 1)
}

function clampTrigger(value) {
  return clamp(value, 0, 1)
}

/** 把单个按键名/别名解析成归一化名；认不出返回 undefined。 */
export function resolveButtonName(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_')
  if (GAMEPAD_BUTTON_NAMES.includes(key)) return key
  return BUTTON_ALIASES[key]
}

function readStick(value) {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return { x: clampAxis(value[0]), y: clampAxis(value[1]) }
  if (typeof value === 'object') return { x: clampAxis(value.x), y: clampAxis(value.y) }
  return undefined
}

/**
 * 把外部输入归一化成完整手柄状态。
 *
 * @param {object} input
 * @param {object} [options]
 * @param {boolean} [options.merge] - true 时在 base 上叠加；默认绝对覆盖（没给的按键视为松开）。
 * @param {object} [options.base] - merge 时的基线状态。
 * @returns {{buttons:object,lstick:object,rstick:object,lt:number,rt:number}}
 */
export function normalizeGamepadState(input, options = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const base = options.merge === true ? normalizeGamepadState(options.base ?? {}) : emptyGamepadState()

  // 允许 `{ gamepad: {...} }` 再包一层
  const pad = source.gamepad !== undefined && typeof source.gamepad === 'object' ? source.gamepad : source

  // 按键：数组 = 按住这些；对象 = 逐键覆盖
  if (Array.isArray(pad.buttons)) {
    if (options.merge !== true) {
      for (const name of GAMEPAD_BUTTON_NAMES) base.buttons[name] = false
    }
    for (const item of pad.buttons) {
      const name = resolveButtonName(item)
      if (name !== undefined) base.buttons[name] = true
    }
  } else if (pad.buttons !== null && typeof pad.buttons === 'object') {
    for (const [key, value] of Object.entries(pad.buttons)) {
      const name = resolveButtonName(key)
      if (name !== undefined) base.buttons[name] = value === true || value === 1 || value === 'true'
    }
  }

  // 方向键简写 dpad: ['up','left']
  if (Array.isArray(pad.dpad)) {
    if (options.merge !== true) {
      for (const name of ['up', 'down', 'left', 'right']) base.buttons[name] = false
    }
    for (const item of pad.dpad) {
      const name = resolveButtonName(item)
      if (name !== undefined && ['up', 'down', 'left', 'right'].includes(name)) base.buttons[name] = true
    }
  }

  // 增量按 / 松
  if (Array.isArray(pad.press)) {
    for (const item of pad.press) {
      const name = resolveButtonName(item)
      if (name !== undefined) base.buttons[name] = true
    }
  }
  if (Array.isArray(pad.release)) {
    for (const item of pad.release) {
      const name = resolveButtonName(item)
      if (name !== undefined) base.buttons[name] = false
    }
  }
  if (Array.isArray(pad.reset)) {
    for (const name of GAMEPAD_BUTTON_NAMES) base.buttons[name] = false
  }

  // 摇杆
  const lstick = readStick(pad.lstick ?? pad.leftStick ?? pad.left_stick)
  if (lstick !== undefined) base.lstick = lstick
  const rstick = readStick(pad.rstick ?? pad.rightStick ?? pad.right_stick)
  if (rstick !== undefined) base.rstick = rstick

  // 扳机
  const lt = pad.lt ?? pad.leftTrigger ?? pad.left_trigger
  if (lt !== undefined) base.lt = clampTrigger(lt)
  const rt = pad.rt ?? pad.rightTrigger ?? pad.right_trigger
  if (rt !== undefined) base.rt = clampTrigger(rt)

  return {
    buttons: { ...base.buttons },
    lstick: { ...base.lstick },
    rstick: { ...base.rstick },
    lt: base.lt,
    rt: base.rt,
  }
}

/** 两个状态是否相同（用于避免重复广播）。 */
export function gamepadStateEquals(a, b) {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  for (const name of GAMEPAD_BUTTON_NAMES) {
    if ((a.buttons?.[name] === true) !== (b.buttons?.[name] === true)) return false
  }
  for (const stick of ['lstick', 'rstick']) {
    if (Math.abs((a[stick]?.x ?? 0) - (b[stick]?.x ?? 0)) > 0.001) return false
    if (Math.abs((a[stick]?.y ?? 0) - (b[stick]?.y ?? 0)) > 0.001) return false
  }
  if (Math.abs((a.lt ?? 0) - (b.lt ?? 0)) > 0.001) return false
  if (Math.abs((a.rt ?? 0) - (b.rt ?? 0)) > 0.001) return false
  return true
}

/** 把 -1..1 的 X 轴映射到 0..65535。 */
function axisX(value) {
  return Math.round(((clampAxis(value) + 1) / 2) * 0xffff)
}

/** 把 -1..1 的 Y 轴映射到 0..65535（向上为 0，向下为 65535，与 SDL/scrcpy 一致）。 */
function axisY(value) {
  return Math.round(((1 - clampAxis(value)) / 2) * 0xffff)
}

/** 方向键 → hat switch 值（0 中立，1 上，顺时针）。 */
export function dpadHatValue(buttons) {
  const up = buttons?.up === true
  const down = buttons?.down === true
  const left = buttons?.left === true
  const right = buttons?.right === true
  if (up) {
    if (left) return 8
    if (right) return 2
    return 1
  }
  if (down) {
    if (left) return 6
    if (right) return 4
    return 5
  }
  if (left) return 7
  if (right) return 3
  return 0
}

/**
 * 生成 15 字节的 UHID 输入报告。
 *
 * 布局：L 摇杆(4) + R 摇杆(4) + LT/RT(4) + 按钮(2, LE) + hat(1)
 *
 * @param {object} state
 * @param {'xbox'|'ps'|'switch'} [type] - 决定 A/B/X/Y 的位映射
 */
export function buildHidReport(state, type = 'xbox') {
  const pad = normalizeGamepadState(state)
  const typeInfo = gamepadTypeInfo(type)
  const buffer = Buffer.alloc(GAMEPAD_REPORT_SIZE)
  buffer.writeUInt16LE(axisX(pad.lstick.x), 0)
  buffer.writeUInt16LE(axisY(pad.lstick.y), 2)
  buffer.writeUInt16LE(axisX(pad.rstick.x), 4)
  buffer.writeUInt16LE(axisY(pad.rstick.y), 6)
  buffer.writeUInt16LE(Math.round(clampTrigger(pad.lt) * 0x7fff), 8)
  buffer.writeUInt16LE(Math.round(clampTrigger(pad.rt) * 0x7fff), 10)
  let bits = 0
  for (const [name, bit] of Object.entries(HID_BUTTON_BITS)) {
    if (pad.buttons[name] !== true) continue
    // A/B/X/Y 按手柄类型换位；其余按键（肩键、start 等）位固定。
    bits |= typeInfo.bits[name] ?? bit
  }
  buffer.writeUInt16LE(bits & 0xffff, 12)
  buffer[14] = dpadHatValue(pad.buttons)
  return buffer
}

/** 对比前后状态，返回按下/松开的按键名（回退 keyevent 用）。 */
export function diffButtons(previous, next) {
  const before = previous?.buttons ?? {}
  const after = next?.buttons ?? {}
  const pressed = []
  const released = []
  for (const name of GAMEPAD_BUTTON_NAMES) {
    const was = before[name] === true
    const now = after[name] === true
    if (now && !was) pressed.push(name)
    else if (!now && was) released.push(name)
  }
  return { pressed, released }
}

const ARROW = { up: '↑', down: '↓', left: '←', right: '→' }

/** 简短文字摘要，给工具结果 / 界面状态栏用。 */
export function gamepadSummary(state) {
  const pad = normalizeGamepadState(state)
  const parts = []
  for (const name of GAMEPAD_BUTTON_NAMES) {
    if (pad.buttons[name] !== true) continue
    parts.push(ARROW[name] ?? name.toUpperCase())
  }
  const fmtStick = (stick, label) => {
    if (Math.abs(stick.x) < 0.05 && Math.abs(stick.y) < 0.05) return ''
    return `${label}(${stick.x.toFixed(2)},${stick.y.toFixed(2)})`
  }
  const ls = fmtStick(pad.lstick, 'L')
  const rs = fmtStick(pad.rstick, 'R')
  if (ls.length > 0) parts.push(ls)
  if (rs.length > 0) parts.push(rs)
  if (pad.lt > 0.02) parts.push(`LT${pad.lt.toFixed(1)}`)
  if (pad.rt > 0.02) parts.push(`RT${pad.rt.toFixed(1)}`)
  return parts.length === 0 ? '中立' : parts.join(' ')
}
