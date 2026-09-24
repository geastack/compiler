import { inertPluginInstance } from '../../../dist/plugins/model.js'

// three's JavaScript compiles unchecked, as a three.js app states it: its JSDoc
// types the program, and none of its checker errors is a defect in the program.
export default function geatscPlugin() {
  return {
    name: 'unchecked-three',
    instantiate: () => ({
      ...inertPluginInstance,
      capabilities: { ...inertPluginInstance.capabilities, uncheckedJavaScript: new Set(['three/src/**']) }
    })
  }
}
