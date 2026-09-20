import { inertPluginInstance } from '../../../dist/plugins/model.js'

export default {
  name: 'invalid-instance',
  instantiate(options) {
    switch (options.get('failure')) {
      case 'throw':
        throw new Error('instance construction failed')
      case 'null':
        return null
      case 'promise':
        return Promise.resolve(inertPluginInstance)
      case 'hook':
        return { ...inertPluginInstance, writeArtifacts: false }
      case 'capabilities':
        return { ...inertPluginInstance, capabilities: {} }
      case 'hostFunctions':
        return { ...inertPluginInstance, capabilities: { ...inertPluginInstance.capabilities, hostFunctions: new Map([['pbGet', 42]]) } }
      case 'hostPreambles':
        return {
          ...inertPluginInstance,
          capabilities: { ...inertPluginInstance.capabilities, hostPreambles: new Map([['pbGet', 'header']]) }
        }
      default:
        return {}
    }
  }
}
