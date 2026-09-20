import assert from 'node:assert/strict'
import { inertPluginInstance } from '../../../dist/plugins/model.js'

export default {
  name: 'panel-setter',
  instantiate(options) {
    assert.equal(options.get('panel.expression'), 'left=right')
    return {
      ...inertPluginInstance,
      capabilities: {
        ...inertPluginInstance.capabilities,
        hostFunctions: new Map([['pbSet', 'pbSet']]),
        hostPreambles: new Map([['pbSet', ['#include "panel_bridge.hpp"']]])
      }
    }
  }
}
