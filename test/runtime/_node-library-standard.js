// @ts-nocheck
// Helper for node-library-native-registries.runtime.js: three's
// StandardNodeLibrary (renderers/webgpu/nodes/StandardNodeLibrary.js), with
// its thirteen materials, nine lights and six tone mappings.
import NodeLibrary from './_node-library.js'
import {
  MeshPhongNodeMaterial,
  MeshStandardNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshToonNodeMaterial,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshNormalNodeMaterial,
  MeshMatcapNodeMaterial,
  LineBasicNodeMaterial,
  LineDashedNodeMaterial,
  PointsNodeMaterial,
  SpriteNodeMaterial,
  ShadowNodeMaterial
} from './_node-library-materials.js'
import {
  PointLight,
  DirectionalLight,
  RectAreaLight,
  SpotLight,
  AmbientLight,
  HemisphereLight,
  LightProbe,
  IESSpotLight,
  ProjectorLight
} from './_node-library-lights.js'
import {
  PointLightNode,
  DirectionalLightNode,
  RectAreaLightNode,
  SpotLightNode,
  AmbientLightNode,
  HemisphereLightNode,
  LightProbeNode,
  IESSpotLightNode,
  ProjectorLightNode
} from './_node-library-nodes.js'
import {
  linearToneMapping,
  reinhardToneMapping,
  cineonToneMapping,
  acesFilmicToneMapping,
  agxToneMapping,
  neutralToneMapping
} from './_node-library-tones.js'

export const LinearToneMapping = 1
export const ReinhardToneMapping = 2
export const CineonToneMapping = 3
export const ACESFilmicToneMapping = 4
export const AgXToneMapping = 6
export const NeutralToneMapping = 7

class StandardNodeLibrary extends NodeLibrary {
  constructor() {
    super()

    this.addMaterial(MeshPhongNodeMaterial, 'MeshPhongMaterial')
    this.addMaterial(MeshStandardNodeMaterial, 'MeshStandardMaterial')
    this.addMaterial(MeshPhysicalNodeMaterial, 'MeshPhysicalMaterial')
    this.addMaterial(MeshToonNodeMaterial, 'MeshToonMaterial')
    this.addMaterial(MeshBasicNodeMaterial, 'MeshBasicMaterial')
    this.addMaterial(MeshLambertNodeMaterial, 'MeshLambertMaterial')
    this.addMaterial(MeshNormalNodeMaterial, 'MeshNormalMaterial')
    this.addMaterial(MeshMatcapNodeMaterial, 'MeshMatcapMaterial')
    this.addMaterial(LineBasicNodeMaterial, 'LineBasicMaterial')
    this.addMaterial(LineDashedNodeMaterial, 'LineDashedMaterial')
    this.addMaterial(PointsNodeMaterial, 'PointsMaterial')
    this.addMaterial(SpriteNodeMaterial, 'SpriteMaterial')
    this.addMaterial(ShadowNodeMaterial, 'ShadowMaterial')

    this.addLight(PointLightNode, PointLight)
    this.addLight(DirectionalLightNode, DirectionalLight)
    this.addLight(RectAreaLightNode, RectAreaLight)
    this.addLight(SpotLightNode, SpotLight)
    this.addLight(AmbientLightNode, AmbientLight)
    this.addLight(HemisphereLightNode, HemisphereLight)
    this.addLight(LightProbeNode, LightProbe)
    this.addLight(IESSpotLightNode, IESSpotLight)
    this.addLight(ProjectorLightNode, ProjectorLight)

    this.addToneMapping(linearToneMapping, LinearToneMapping)
    this.addToneMapping(reinhardToneMapping, ReinhardToneMapping)
    this.addToneMapping(cineonToneMapping, CineonToneMapping)
    this.addToneMapping(acesFilmicToneMapping, ACESFilmicToneMapping)
    this.addToneMapping(agxToneMapping, AgXToneMapping)
    this.addToneMapping(neutralToneMapping, NeutralToneMapping)
  }
}

export default StandardNodeLibrary
