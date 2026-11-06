/**
 * 面板坐标映射（纯函数，浏览器与 node:test 共用）。
 *
 * 画面用 CSS object-fit: contain 显示：元素盒子可能比图片大，左右或上下留边。
 * 只有真正绘制出来的图像区域才接收输入，坐标按“当前图像尺寸”映射，不做二次缩放。
 */

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

/**
 * 计算包含式缩放后图片在元素盒子中的实际绘制矩形。
 * @param {{left:number,top:number,width:number,height:number}} rect 元素盒子（getBoundingClientRect）
 * @param {number} imageWidth 图像原始宽度（设备像素）
 * @param {number} imageHeight 图像原始高度（设备像素）
 */
export function containRect(rect, imageWidth, imageHeight) {
  if (rect === null || typeof rect !== 'object') return null
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null
  const scale = Math.min(rect.width / imageWidth, rect.height / imageHeight)
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  const drawWidth = imageWidth * scale
  const drawHeight = imageHeight * scale
  return {
    scale,
    drawWidth,
    drawHeight,
    offsetX: rect.left + (rect.width - drawWidth) / 2,
    offsetY: rect.top + (rect.height - drawHeight) / 2,
  }
}

/**
 * 把视口坐标映射到设备像素坐标；点在留边区域时返回 null。
 * @param {{clientX:number,clientY:number,rect:{left:number,top:number,width:number,height:number},imageWidth:number,imageHeight:number}} input
 * @returns {{x:number,y:number,scale:number,drawWidth:number,drawHeight:number,offsetX:number,offsetY:number}|null}
 */
export function mapContainPoint(input) {
  if (input === null || typeof input !== 'object') return null
  const { clientX, clientY, rect, imageWidth, imageHeight } = input
  const box = containRect(rect, imageWidth, imageHeight)
  if (box === null) return null
  if (clientX < box.offsetX || clientX > box.offsetX + box.drawWidth) return null
  if (clientY < box.offsetY || clientY > box.offsetY + box.drawHeight) return null
  const x = clamp((clientX - box.offsetX) / box.scale, 0, imageWidth - 1)
  const y = clamp((clientY - box.offsetY) / box.scale, 0, imageHeight - 1)
  return { ...box, x: Math.round(x), y: Math.round(y) }
}

/** 判断一次指针移动是否算“点击”而不是滑动。 */
export function isTap(start, end, threshold = 8) {
  if (start === null || end === null) return false
  const limit = Number.isFinite(threshold) && threshold >= 0 ? threshold : 8
  return Math.abs(end.clientX - start.clientX) <= limit && Math.abs(end.clientY - start.clientY) <= limit
}

/** 把设备坐标限制在屏幕范围并归一成整数。 */
export function clampDevicePoint(point, imageWidth, imageHeight) {
  if (point === null || typeof point !== 'object') return null
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null
  return {
    x: Math.round(clamp(point.x, 0, imageWidth - 1)),
    y: Math.round(clamp(point.y, 0, imageHeight - 1)),
  }
}
