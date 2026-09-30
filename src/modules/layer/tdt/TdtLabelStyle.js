import { Cesium } from '../../../libs'

const cartographicScratch = new Cesium.Cartographic()

const DEF_LABEL = {
  font: '28px sans-serif',
  scale: 0.5,
  fillColor: Cesium.Color.WHITE,
  outlineColor: Cesium.Color.BLACK,
  outlineWidth: 2,
  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
  horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
  verticalOrigin: Cesium.VerticalOrigin.TOP,
  pixelOffset: new Cesium.Cartesian2(0, 8),
  // Screen-aligned text must not be clipped by terrain at grazing angles.
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
}

function parseColor(value) {
  // Service colors are packed ARGB, independent of host byte order.
  return Cesium.Color.fromBytes(
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  )
}

export function createTdtEntity(poi, tile, options, id) {
  const [lng, lat, height = 0] = poi.coordinate || []
  if (
    poi.geometryType !== 0 ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(height) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    return undefined
  }
  const serverLabel = {}
  if (options.serverFirstStyle && tile.type === 'poi') {
    const fontStyle = poi.fontStyle || 0
    serverLabel.font = [
      fontStyle & 1 ? 'bold' : '',
      fontStyle & 2 ? 'italic' : '',
      `${poi.fontSize}px`,
      tile.data.stringTable[poi.fontNameIndex] || 'sans-serif',
    ]
      .filter(Boolean)
      .join(' ')
    serverLabel.fillColor = parseColor(poi.fontColor)
    serverLabel.outlineColor = parseColor(poi.shiningColor)
    if (poi.shiningSize != null) {
      serverLabel.outlineWidth = poi.shiningSize
    }
  }
  const heightReference =
    poi.zCoordType === 0
      ? Cesium.HeightReference.CLAMP_TO_GROUND
      : poi.zCoordType === 2
      ? Cesium.HeightReference.RELATIVE_TO_GROUND
      : Cesium.HeightReference.NONE
  const entity = new Cesium.Entity({
    id,
    name: poi.name,
    position: Cesium.Cartesian3.fromDegrees(
      lng,
      lat,
      poi.zCoordType === 1 ? 0 : height
    ),
    label: {
      ...DEF_LABEL,
      heightReference,
      ...options.labelGraphics,
      ...serverLabel,
      text: poi.name,
    },
  })
  entity._tdtPriority = poi.priority ?? 0
  if (options.icoUrl && poi.symbolID >= 0) {
    const subdomains = options.subdomains ?? '01234567'
    const key = options.key ?? options.token ?? ''
    entity.billboard = {
      width: 18,
      height: 18,
      scale: 1,
      heightReference,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      ...options.billboardGraphics,
      ...(options.serverFirstStyle
        ? { width: poi.displayHeight, height: poi.displayHeight }
        : {}),
      image: Cesium.Resource.createIfNeeded(options.icoUrl).getDerivedResource({
        templateValues: {
          x: tile.x,
          y: tile.y,
          z: tile.level + 1,
          id: poi.symbolID,
          // Keep each symbol on one host so Cesium can reuse its image.
          s: subdomains.length
            ? subdomains[poi.symbolID % subdomains.length]
            : '',
          key,
          token: key,
        },
        proxy: options.proxy,
      }),
    }
  }
  return entity
}

function getValue(value, time, fallback) {
  return value?.getValue(time) ?? fallback
}

export function getTdtLabelPosition(entity, scene, time) {
  const position = entity.position.getValue(time)
  if (!position) return undefined
  const reference = getValue(
    entity.label.heightReference,
    time,
    Cesium.HeightReference.NONE
  )
  if (
    !scene.globe ||
    (reference !== Cesium.HeightReference.CLAMP_TO_GROUND &&
      reference !== Cesium.HeightReference.RELATIVE_TO_GROUND)
  ) {
    return position
  }
  const ellipsoid = scene.globe.ellipsoid
  const cartographic = ellipsoid.cartesianToCartographic(
    position,
    cartographicScratch
  )
  const ground = scene.globe.getHeight(cartographic)
  if (!Cesium.defined(ground)) {
    return position
  }
  cartographic.height =
    ground +
    (reference === Cesium.HeightReference.RELATIVE_TO_GROUND
      ? cartographic.height
      : 0)
  return ellipsoid.cartographicToCartesian(cartographic)
}

function getBox(graphics, point, width, height, time) {
  const offset = getValue(graphics.pixelOffset, time, Cesium.Cartesian2.ZERO)
  const horizontal = getValue(
    graphics.horizontalOrigin,
    time,
    Cesium.HorizontalOrigin.CENTER
  )
  const vertical = getValue(
    graphics.verticalOrigin,
    time,
    Cesium.VerticalOrigin.CENTER
  )
  return {
    left:
      point.x +
      offset.x -
      (horizontal === Cesium.HorizontalOrigin.LEFT
        ? 0
        : horizontal === Cesium.HorizontalOrigin.RIGHT
        ? width
        : width / 2),
    top:
      point.y +
      offset.y -
      (vertical === Cesium.VerticalOrigin.TOP
        ? 0
        : vertical === Cesium.VerticalOrigin.CENTER
        ? height / 2
        : height),
    width,
    height,
  }
}

function isVisible(graphics, time, distance) {
  if (!getValue(graphics.show, time, true)) return false
  const range = getValue(graphics.distanceDisplayCondition, time)
  return (
    !range ||
    distance === undefined ||
    (distance >= range.near && distance <= range.far)
  )
}

// Approximate text bounds in CSS pixels; no drawing-buffer/DPR conversion.
export function getTdtLabelBounds(
  entity,
  point,
  time,
  context,
  padding,
  measureText,
  distance
) {
  const label = entity.label
  const font = getValue(label.font, time, DEF_LABEL.font)
  const fontSize = Number(/([\d.]+)px/.exec(font)?.[1] || 28)
  const scale = getValue(label.scale, time, 1)
  const measure =
    measureText ||
    ((font, text) => {
      context.font = font
      return context.measureText(text).width
    })
  const lines = getValue(label.text, time, '').split('\n')
  const outline = getValue(label.outlineWidth, time, 0)
  let textWidth = 0
  let hasText = false
  for (const line of lines) {
    textWidth = Math.max(textWidth, measure(font, line))
    hasText ||= line.length > 0
  }
  const width = (textWidth + outline * 2) * scale
  const height = (lines.length * fontSize * 1.2 + outline * 2) * scale
  const box = getBox(label, point, width, height, time)
  const showLabel = isVisible(label, time, distance) && hasText && scale > 0
  const showIcon =
    entity.billboard && isVisible(entity.billboard, time, distance)
  if (!showLabel && !showIcon) return undefined
  if (!showLabel) {
    box.left = Infinity
    box.top = Infinity
    box.width = -Infinity
    box.height = -Infinity
  }
  let right = showLabel ? box.left + box.width : -Infinity
  let bottom = showLabel ? box.top + box.height : -Infinity
  if (showIcon) {
    const icon = entity.billboard
    const iconScale = getValue(icon.scale, time, 1)
    const iconBox = getBox(
      icon,
      point,
      getValue(icon.width, time, 18) * iconScale,
      getValue(icon.height, time, 18) * iconScale,
      time
    )
    box.left = Math.min(box.left, iconBox.left)
    box.top = Math.min(box.top, iconBox.top)
    right = Math.max(right, iconBox.left + iconBox.width)
    bottom = Math.max(bottom, iconBox.top + iconBox.height)
  }
  return {
    left: box.left - padding[3],
    top: box.top - padding[0],
    right: right + padding[1],
    bottom: bottom + padding[2],
  }
}
