// @ts-nocheck
// Helper for node-library-native-registries.runtime.js: three's
// renderers/common/nodes/NodeLibrary.js as the native-webgpu plugin corrects
// its JSDoc, with the import() types naming this test's helpers. `warn`
// prints to stdout so the test sees a refused redefinition.
const warn = (message) => console.log('warn: ' + message)

/**
 * The purpose of a node library is to assign node implementations
 * to existing library features. In `WebGPURenderer` lights, materials
 * which are not based on `NodeMaterial` as well as tone mapping techniques
 * are implemented with node-based modules.
 *
 * @private
 */
class NodeLibrary {
  /**
   * Constructs a new node library.
   */
  constructor() {
    /**
     * A weak map that maps lights to light nodes.
     *
     * @type {WeakMap<(typeof import('./_node-library-lights.js').Light|typeof import('./_node-library-lights.js').PointLight|typeof import('./_node-library-lights.js').DirectionalLight|typeof import('./_node-library-lights.js').RectAreaLight|typeof import('./_node-library-lights.js').SpotLight|typeof import('./_node-library-lights.js').AmbientLight|typeof import('./_node-library-lights.js').HemisphereLight|typeof import('./_node-library-lights.js').LightProbe|typeof import('./_node-library-lights.js').IESSpotLight|typeof import('./_node-library-lights.js').ProjectorLight), (new (light: import('./_node-library-lights.js').Light) => import('./_node-library-nodes.js').AnalyticLightNode)>}
     */
    this.lightNodes = new WeakMap()

    /**
     * A map that maps materials to node materials.
     *
     * @type {Map<string, (new () => import('./_node-library-materials.js').NodeMaterial)>}
     */
    this.materialNodes = new Map()

    /**
     * A map that maps tone mapping techniques (constants)
     * to tone mapping node functions.
     *
     * @type {Map<number, ((color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node)>}
     */
    this.toneMappingNodes = new Map()
  }

  /**
   * Returns a matching node material instance for the given material object.
   *
   * This method also assigns/copies the properties of the given material object
   * to the node material. This is done to make sure the current material
   * configuration carries over to the node version.
   *
   * @param {import('./_node-library-materials.js').Material|import('./_node-library-materials.js').NodeMaterial} material - A material.
   * @return {?import('./_node-library-materials.js').NodeMaterial} The corresponding node material.
   */
  fromMaterial(material) {
    if (material.isNodeMaterial) return material

    let nodeMaterial = null

    const nodeMaterialClass = this.getMaterialNodeClass(material.type)

    if (nodeMaterialClass !== null) {
      nodeMaterial = new nodeMaterialClass()

      for (const key in material) {
        nodeMaterial[key] = material[key]
      }
    }

    return nodeMaterial
  }

  /**
   * Adds a tone mapping node function for a tone mapping technique (constant).
   *
   * @param {((color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node)} toneMappingNode - The tone mapping node function.
   * @param {number} toneMapping - The tone mapping.
   */
  addToneMapping(toneMappingNode, toneMapping) {
    this.addType(toneMappingNode, toneMapping, this.toneMappingNodes)
  }

  /**
   * Returns a tone mapping node function for a tone mapping technique (constant).
   *
   * @param {number} toneMapping - The tone mapping.
   * @return {?((color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node)} The tone mapping node function. Returns `null` if no node function is found.
   */
  getToneMappingFunction(toneMapping) {
    return this.toneMappingNodes.get(toneMapping) || null
  }

  /**
   * Returns a node material class definition for a material type.
   *
   * @param {string} materialType - The material type.
   * @return {?(new () => import('./_node-library-materials.js').NodeMaterial)} The node material class definition. Returns `null` if no node material is found.
   */
  getMaterialNodeClass(materialType) {
    return this.materialNodes.get(materialType) || null
  }

  /**
   * Adds a node material class definition for a given material type.
   *
   * @param {(new () => import('./_node-library-materials.js').NodeMaterial)} materialNodeClass - The node material class definition.
   * @param {string} materialClassType - The material type.
   */
  addMaterial(materialNodeClass, materialClassType) {
    this.addType(materialNodeClass, materialClassType, this.materialNodes)
  }

  /**
   * Returns a light node class definition for a light class definition.
   *
   * @param {(typeof import('./_node-library-lights.js').Light|typeof import('./_node-library-lights.js').PointLight|typeof import('./_node-library-lights.js').DirectionalLight|typeof import('./_node-library-lights.js').RectAreaLight|typeof import('./_node-library-lights.js').SpotLight|typeof import('./_node-library-lights.js').AmbientLight|typeof import('./_node-library-lights.js').HemisphereLight|typeof import('./_node-library-lights.js').LightProbe|typeof import('./_node-library-lights.js').IESSpotLight|typeof import('./_node-library-lights.js').ProjectorLight)} light - The light class definition.
   * @return {?(new (light: import('./_node-library-lights.js').Light) => import('./_node-library-nodes.js').AnalyticLightNode)} The light node class definition. Returns `null` if no light node is found.
   */
  getLightNodeClass(light) {
    return this.lightNodes.get(light) || null
  }

  /**
   * Adds a light node class definition for a given light class definition.
   *
   * @param {(new (light: import('./_node-library-lights.js').Light) => import('./_node-library-nodes.js').AnalyticLightNode)} lightNodeClass - The light node class definition.
   * @param {(typeof import('./_node-library-lights.js').Light|typeof import('./_node-library-lights.js').PointLight|typeof import('./_node-library-lights.js').DirectionalLight|typeof import('./_node-library-lights.js').RectAreaLight|typeof import('./_node-library-lights.js').SpotLight|typeof import('./_node-library-lights.js').AmbientLight|typeof import('./_node-library-lights.js').HemisphereLight|typeof import('./_node-library-lights.js').LightProbe|typeof import('./_node-library-lights.js').IESSpotLight|typeof import('./_node-library-lights.js').ProjectorLight)} lightClass - The light class definition.
   */
  addLight(lightNodeClass, lightClass) {
    this.addClass(lightNodeClass, lightClass, this.lightNodes)
  }

  /**
   * Adds a node class definition for the given type to the provided type library.
   *
   * @param {(new () => import('./_node-library-materials.js').NodeMaterial)|((color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node)} nodeClass - The node class definition.
   * @param {number|string} type - The object type.
   * @param {Map<string, (new () => import('./_node-library-materials.js').NodeMaterial)>|Map<number, ((color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node)>} library - The type library.
   */
  addType(nodeClass, type, library) {
    if (library.has(type)) {
      warn(`Redefinition of node ${type}`)
      return
    }

    if (typeof nodeClass !== 'function') throw new Error(`THREE.NodeLibrary: Node class ${nodeClass.name} is not a class.`)
    if (typeof type === 'function' || typeof type === 'object') throw new Error(`THREE.NodeLibrary: Base class ${type} is not a class.`)

    library.set(type, nodeClass)
  }

  /**
   * Adds a node class definition for the given class definition to the provided type library.
   *
   * @param {(new (light: import('./_node-library-lights.js').Light) => import('./_node-library-nodes.js').AnalyticLightNode)} nodeClass - The node class definition.
   * @param {(typeof import('./_node-library-lights.js').Light|typeof import('./_node-library-lights.js').PointLight|typeof import('./_node-library-lights.js').DirectionalLight|typeof import('./_node-library-lights.js').RectAreaLight|typeof import('./_node-library-lights.js').SpotLight|typeof import('./_node-library-lights.js').AmbientLight|typeof import('./_node-library-lights.js').HemisphereLight|typeof import('./_node-library-lights.js').LightProbe|typeof import('./_node-library-lights.js').IESSpotLight|typeof import('./_node-library-lights.js').ProjectorLight)} baseClass - The class definition.
   * @param {WeakMap<(typeof import('./_node-library-lights.js').Light|typeof import('./_node-library-lights.js').PointLight|typeof import('./_node-library-lights.js').DirectionalLight|typeof import('./_node-library-lights.js').RectAreaLight|typeof import('./_node-library-lights.js').SpotLight|typeof import('./_node-library-lights.js').AmbientLight|typeof import('./_node-library-lights.js').HemisphereLight|typeof import('./_node-library-lights.js').LightProbe|typeof import('./_node-library-lights.js').IESSpotLight|typeof import('./_node-library-lights.js').ProjectorLight), (new (light: import('./_node-library-lights.js').Light) => import('./_node-library-nodes.js').AnalyticLightNode)>} library - The type library.
   */
  addClass(nodeClass, baseClass, library) {
    if (library.has(baseClass)) {
      warn(`Redefinition of node ${baseClass.name}`)
      return
    }

    if (typeof nodeClass !== 'function') throw new Error(`THREE.NodeLibrary: Node class ${nodeClass.name} is not a class.`)
    if (typeof baseClass !== 'function') throw new Error(`THREE.NodeLibrary: Base class ${baseClass.name} is not a class.`)

    library.set(baseClass, nodeClass)
  }
}

export default NodeLibrary
