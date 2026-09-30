import { Cesium } from '../../../libs'
import TdtQuantizedTerrainData from './TdtQuantizedTerrainData'

class TdtTerrainData extends Cesium.HeightmapTerrainData {
  upsample(...args) {
    // Keep the heightmap fallback while finer source DEM tiles are available.
    if (this.childTileMask !== 0) {
      return super.upsample(...args)
    }
    return TdtQuantizedTerrainData.createChild(this, ...args)
  }
}

export default TdtTerrainData
