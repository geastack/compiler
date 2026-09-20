import { inertPluginInstance } from '../../../dist/plugins/model.js'

export const geatscPlugin = {
  name: 'panel-override',
  instantiate: () => ({
    ...inertPluginInstance,
    capabilities: {
      ...inertPluginInstance.capabilities,
      hostFunctions: new Map([['pbGet', 'pbGetOverride']]),
      hostPreambles: new Map([['pbGetOverride', ['#include "panel_bridge.hpp"']]])
    }
  })
}
