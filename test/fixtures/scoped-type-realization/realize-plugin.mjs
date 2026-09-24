import { inertPluginInstance } from '../../../dist/plugins/model.js'

// Inside node-lib's `src/`, an unimported JSDoc `Node` is node-lib's own class.
export default function geatscPlugin() {
  return {
    name: 'realize-node-lib-node',
    instantiate: () => ({
      ...inertPluginInstance,
      capabilities: {
        ...inertPluginInstance.capabilities,
        ambientTypeRealizations: new Map([
          ['Node', { type: 'default', importedFrom: 'node-lib/src/core/Node.js', within: new Set(['node-lib/src/**']) }]
        ])
      }
    })
  }
}
