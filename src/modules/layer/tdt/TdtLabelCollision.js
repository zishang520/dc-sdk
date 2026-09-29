import { Cesium } from '../../../libs'
import { getTdtLabelBounds, getTdtLabelPosition } from './TdtLabelStyle'

// Only properties read by getTdtLabelBounds affect the relative box.
const BOUNDS_PROPERTIES = [
  'show',
  'text',
  'font',
  'scale',
  'outlineWidth',
  'pixelOffset',
  'horizontalOrigin',
  'verticalOrigin',
  'width',
  'height',
  'distanceDisplayCondition',
]
const GRAPHIC_PROPERTIES = [
  ...BOUNDS_PROPERTIES,
  'heightReference',
  'eyeOffset',
  'showBackground',
  'backgroundPadding',
]
const NO_PADDING = [0, 0, 0, 0]
const TERRAIN_UPDATE_INTERVAL = 250
const pointScratch = new Cesium.Cartesian2()

// Only compare boxes in overlapping screen cells. Large offscreen boxes are
// clipped for indexing so they cannot allocate an unbounded grid.
class TdtCollisionIndex {
  constructor(width, height) {
    this._width = width
    this._height = height
    this._cells = new Map()
  }

  add(box) {
    if (
      !box ||
      !Number.isFinite(box.left) ||
      !Number.isFinite(box.right) ||
      !Number.isFinite(box.top) ||
      !Number.isFinite(box.bottom) ||
      box.right <= box.left ||
      box.bottom <= box.top ||
      box.right < 0 ||
      box.bottom < 0 ||
      box.left > this._width ||
      box.top > this._height
    ) {
      return false
    }
    const left = Math.floor(Math.max(0, box.left) / 64)
    const right = Math.floor(Math.min(this._width, box.right) / 64)
    const top = Math.floor(Math.max(0, box.top) / 64)
    const bottom = Math.floor(Math.min(this._height, box.bottom) / 64)
    const keys = []
    const checked = new Set()
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const key = `${x}/${y}`
        keys.push(key)
        const cell = this._cells.get(key)
        if (!cell) continue
        for (const other of cell) {
          if (checked.has(other)) continue
          checked.add(other)
          if (
            box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top
          ) {
            return false
          }
        }
      }
    }
    for (const key of keys) {
      if (!this._cells.has(key)) this._cells.set(key, [])
      this._cells.get(key).push(box)
    }
    return true
  }
}

class TdtLabelCollision {
  constructor(entities, context) {
    this._entities = entities
    this._context = context
    this._textWidths = new Map()
    this._positions = new WeakMap()
    this._terrainVersion = 0
    this._terrainDirty = false
    this._terrainImmediate = false
    this._lastTerrainUpdate = -Infinity
    this._bounds = new WeakMap()
    this._dirty = true
    this._sorted = undefined
    this._removeChanged = entities.collectionChanged.addEventListener(
      (_, added, removed, changed) => {
        if (this._updating) return
        for (const entity of [...removed, ...changed]) {
          this._positions.delete(entity)
          this._bounds.delete(entity)
        }
        this.invalidate()
      }
    )
    this._fonts = typeof document === 'undefined' ? undefined : document.fonts
    this._fontsChanged = () => {
      this._textWidths.clear()
      this._bounds = new WeakMap()
      this.invalidate(false)
    }
    this._fonts?.addEventListener('loadingdone', this._fontsChanged)
    this._measureText = (font, text) => {
      const key = `${font}\0${text}`
      if (!this._textWidths.has(key)) {
        if (this._textWidths.size >= 2048) {
          this._textWidths.delete(this._textWidths.keys().next().value)
        }
        this._context.font = font
        this._textWidths.set(key, this._context.measureText(text).width)
      }
      return this._textWidths.get(key)
    }
  }

  invalidate(sort = true) {
    this._dirty = true
    if (sort) this._sorted = undefined
  }

  invalidateTerrain(immediate = true) {
    // Coalesce notifications until the next update. Progress events also include
    // imagery loading; completion and explicit terrain changes bypass throttling.
    this._terrainDirty = true
    this._terrainImmediate ||= immediate
  }

  _getPosition(entity, scene, time) {
    let cached = this._positions.get(entity)
    if (!cached) {
      const reference = entity.label.heightReference?.getValue(time)
      cached = {
        constant:
          Cesium.Property.isConstant(entity.position) &&
          Cesium.Property.isConstant(entity.label.heightReference),
        terrain:
          reference === Cesium.HeightReference.CLAMP_TO_GROUND ||
          reference === Cesium.HeightReference.RELATIVE_TO_GROUND,
        version: this._terrainVersion,
        value: getTdtLabelPosition(entity, scene, time),
      }
      this._positions.set(entity, cached)
    } else if (
      !cached.constant ||
      (cached.terrain && cached.version !== this._terrainVersion)
    ) {
      cached.value = getTdtLabelPosition(entity, scene, time)
      cached.version = this._terrainVersion
    }
    return cached.value
  }

  _getBounds(entity, point, time, padding, distance) {
    // Cache offsets relative to the anchor; projection and padding stay live.
    let cached = this._bounds.get(entity)
    if (!cached || !cached.constant) {
      const value = getTdtLabelBounds(
        entity,
        Cesium.Cartesian2.ZERO,
        time,
        this._context,
        NO_PADDING,
        this._measureText,
        distance
      )
      if (!cached) {
        cached = {
          constant: [entity.label, entity.billboard].every(
            (graphic) =>
              !graphic ||
              (!graphic.distanceDisplayCondition &&
                BOUNDS_PROPERTIES.every((name) =>
                  Cesium.Property.isConstant(graphic[name])
                ))
          ),
          value,
        }
        this._bounds.set(entity, cached)
      } else {
        cached.value = value
      }
    }
    const box = cached.value
    return box
      ? {
          left: point.x + box.left - padding[3],
          top: point.y + box.top - padding[0],
          right: point.x + box.right + padding[1],
          bottom: point.y + box.bottom + padding[2],
        }
      : undefined
  }

  update(scene, time, padding, autoCollide = true) {
    const camera = scene.camera
    const width = scene.canvas.clientWidth
    const height = scene.canvas.clientHeight
    const projection = camera.frustum.projectionMatrix
    if (
      this._terrain !== scene.terrainProvider ||
      this._globe !== scene.globe ||
      this._mode !== scene.mode ||
      this._exaggeration !== scene.verticalExaggeration ||
      this._relativeHeight !== scene.verticalExaggerationRelativeHeight
    ) {
      this.invalidateTerrain()
    }
    if (this._terrainDirty) {
      const now = performance.now()
      if (
        this._terrainImmediate ||
        now - this._lastTerrainUpdate >= TERRAIN_UPDATE_INTERVAL
      ) {
        this._terrainVersion++
        this._terrainDirty = false
        this._terrainImmediate = false
        this._lastTerrainUpdate = now
        this.invalidate(false)
      }
    }
    if (
      !this._dirty &&
      !this._dynamic &&
      this._width === width &&
      this._height === height &&
      this._autoCollide === autoCollide &&
      Cesium.Matrix4.equals(this._view, camera.viewMatrix) &&
      Cesium.Matrix4.equals(this._projection, projection)
    ) {
      return false
    }
    this._view = Cesium.Matrix4.clone(camera.viewMatrix, this._view)
    this._projection = Cesium.Matrix4.clone(projection, this._projection)
    this._width = width
    this._height = height
    this._mode = scene.mode
    this._autoCollide = autoCollide
    this._terrain = scene.terrainProvider
    this._globe = scene.globe
    this._exaggeration = scene.verticalExaggeration
    this._relativeHeight = scene.verticalExaggerationRelativeHeight
    this._dirty = false
    if (!this._sorted) {
      this._sorted = [...this._entities.values].sort(
        (a, b) => a._tdtPriority - b._tdtPriority
      )
      this._dynamic = this._sorted.some(
        (entity) =>
          entity.availability ||
          !Cesium.Property.isConstant(entity.position) ||
          [entity.label, entity.billboard].some(
            (graphic) =>
              graphic &&
              GRAPHIC_PROPERTIES.some(
                (name) => !Cesium.Property.isConstant(graphic[name])
              )
          )
      )
    }
    const index = autoCollide ? new TdtCollisionIndex(width, height) : undefined
    const occluder =
      scene.mode === Cesium.SceneMode.SCENE3D
        ? new Cesium.EllipsoidalOccluder(
            scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
            camera.positionWC
          )
        : undefined
    let changed = false
    this._updating = true
    this._entities.suspendEvents()
    try {
      for (const entity of this._sorted) {
        const position =
          entity.isAvailable(time) && this._getPosition(entity, scene, time)
        let show =
          !!position && (!occluder || occluder.isPointVisible(position))
        if (show && index) {
          show = false
          const point = Cesium.SceneTransforms.worldToWindowCoordinates(
            scene,
            position,
            pointScratch
          )
          if (point) {
            const distance =
              entity.label.distanceDisplayCondition ||
              entity.billboard?.distanceDisplayCondition
                ? Cesium.Cartesian3.distance(camera.positionWC, position)
                : undefined
            show = index.add(
              this._getBounds(entity, point, time, padding, distance)
            )
          }
        }
        if (entity.show !== show) {
          entity.show = show
          changed = true
        }
      }
    } finally {
      this._entities.resumeEvents()
      this._updating = false
    }
    return changed
  }

  destroy() {
    this._removeChanged()
    this._fonts?.removeEventListener('loadingdone', this._fontsChanged)
    this._textWidths.clear()
    this._positions = new WeakMap()
    this._bounds = new WeakMap()
    this._sorted = undefined
  }
}

export default TdtLabelCollision
