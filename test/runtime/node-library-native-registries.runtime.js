// @ts-nocheck
//! expect: 13 6
//! expect: MeshBasicNodeMaterial true 0.5 true null
//! expect: PointLightNode true
//! expect: DirectionalLightNode true
//! expect: RectAreaLightNode true
//! expect: SpotLightNode true
//! expect: AmbientLightNode true
//! expect: HemisphereLightNode true
//! expect: LightProbeNode true
//! expect: IESSpotLightNode true
//! expect: ProjectorLightNode true
//! expect: warn: LightsNode.setupNodeLights: Light node not found for Light
//! expect: 9 true
//! expect: 1 11.5 21.5 31.5 41.5 51.5 null
//! expect: warn: Redefinition of node MeshBasicMaterial
//! expect: warn: Redefinition of node PointLight
//! expect: warn: Redefinition of node 1
//! emitted-has: gea::Map<double, gea::CallableObject<
//! emitted-has: gea::Map<std::string, gea::ConstructorObject<
//! emitted-has: gea::WeakMap<gea_union_
//! emitted-lacks: gea::Map<gea::Value
//! emitted-lacks: gea::WeakMap<gea::Value
// three's NodeLibrary registries as WebGPURenderer builds and reads them,
// with the JSDoc the native-webgpu plugin corrects: StandardNodeLibrary
// registers thirteen node material classes by material type, nine light node
// classes by light class in a WeakMap, and six TSL tone-mapping functions
// (`Fn( ... ).setLayout( ... )`, a Proxy) by tone-mapping constant. NodeBuilder
// converts a material, LightsNode looks a light's node class up by
// `light.constructor` and makes the node, and ToneMappingNode calls the
// function it finds. The renderer's bound callback leaves the census of the
// library's callers open, as WebGPURenderer's does, so a tag the compiler
// erased would be refused rather than inferred.
import StandardNodeLibrary, { LinearToneMapping } from './_node-library-standard.js'
import {
  Light,
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
  Material,
  MeshBasicMaterial,
  UnregisteredMaterial,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial
} from './_node-library-materials.js'
import { Node, AnalyticLightNode, PointLightNode, SpotLightNode } from './_node-library-nodes.js'
import { linearToneMapping } from './_node-library-tones.js'

class Renderer {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.library = new StandardNodeLibrary()
  }
}

/** @param {Renderer} renderer @param {Material} material */
function nodeMaterialOf(renderer, material) {
  return renderer.library.fromMaterial(material)
}

/** @param {Renderer} renderer @param {Array<Light>} lights */
function setupNodeLights(renderer, lights) {
  const nodeLibrary = renderer.library
  /** @type {Array<AnalyticLightNode>} */
  const lightNodes = []
  for (const light of lights) {
    const lightNodeClass = nodeLibrary.getLightNodeClass(light.constructor)
    if (lightNodeClass === null) {
      console.log(`warn: LightsNode.setupNodeLights: Light node not found for ${light.constructor.name}`)
      continue
    }
    const lightNode = new lightNodeClass(light)
    console.log(lightNode.type, lightNode.light === light)
    lightNodes.push(lightNode)
  }
  return lightNodes
}

/** @param {Renderer} renderer @param {number} toneMapping */
function toneMapped(renderer, toneMapping) {
  const toneMappingFn = renderer.library.getToneMappingFunction(toneMapping)
  if (toneMappingFn === null) return null
  return toneMappingFn(new Node(0.5), new Node(3)).value
}

const renderer = new Renderer()
const library = renderer.library
console.log(library.materialNodes.size, library.toneMappingNodes.size)

const basic = new MeshBasicMaterial()
basic.opacity = 0.5
const converted = nodeMaterialOf(renderer, basic)
const standard = new MeshStandardNodeMaterial()
console.log(
  converted.type,
  converted instanceof MeshBasicNodeMaterial,
  converted.opacity,
  nodeMaterialOf(renderer, standard) === standard,
  nodeMaterialOf(renderer, new UnregisteredMaterial())
)

const lights = [
  new PointLight(),
  new DirectionalLight(),
  new RectAreaLight(),
  new SpotLight(),
  new AmbientLight(),
  new HemisphereLight(),
  new LightProbe(),
  new IESSpotLight(),
  new ProjectorLight(),
  new Light()
]
const lightNodes = setupNodeLights(renderer, lights)
console.log(lightNodes.length, lightNodes[8] instanceof SpotLightNode)

console.log(
  toneMapped(renderer, LinearToneMapping),
  toneMapped(renderer, 2),
  toneMapped(renderer, 3),
  toneMapped(renderer, 4),
  toneMapped(renderer, 6),
  toneMapped(renderer, 7),
  toneMapped(renderer, 0)
)

library.addMaterial(MeshBasicNodeMaterial, 'MeshBasicMaterial')
library.addLight(PointLightNode, PointLight)
library.addToneMapping(linearToneMapping, LinearToneMapping)
console.log(library.materialNodes.size, library.toneMappingNodes.size)
