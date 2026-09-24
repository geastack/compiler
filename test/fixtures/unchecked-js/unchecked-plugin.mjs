import { inertPluginInstance } from '../../../dist/plugins/model.js'

// A host stating one package's `src/` tree unchecked, and nothing else.
export default function geatscPlugin() {
  return {
    name: 'unchecked-loose-lib',
    instantiate: () => ({
      ...inertPluginInstance,
      capabilities: { ...inertPluginInstance.capabilities, uncheckedJavaScript: new Set(['loose-lib/src/**']) }
    })
  }
}
