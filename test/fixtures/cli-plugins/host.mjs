import assert from 'node:assert/strict'
const { inertPluginInstance } = await import('../../../dist/plugins/model.js')

let created = false
let instantiated = false
export function geatscPlugin() {
  assert.equal(created, false, 'duplicate plugin factory invocation')
  created = true
  return {
    name: 'panel-host',
    instantiate(options) {
      assert.equal(instantiated, false, 'duplicate plugin instantiation')
      instantiated = true
      assert.ok(options instanceof Map)
      assert.equal(options.get('panel.binding'), 'pbGet')
      assert.equal(options.get('panel.expression'), 'left=right')
      assert.equal(options.get('panel.empty'), '')
      assert.equal(options.get('gea.ir'), options.get('panel.expected-ir') ?? '')
      return {
        ...inertPluginInstance,
        capabilities: {
          ...inertPluginInstance.capabilities,
          hostFunctions: new Map([[options.get('panel.binding'), 'pbGet']]),
          hostPreambles: new Map([['pbGet', ['#include "panel_bridge.hpp"']]])
        }
      }
    }
  }
}

export default geatscPlugin
