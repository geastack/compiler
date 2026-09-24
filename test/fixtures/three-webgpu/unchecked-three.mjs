import { inertPluginInstance } from '../../../dist/plugins/model.js'

// three's JavaScript compiles unchecked, as a three.js app states it: its JSDoc
// types the program, and none of its checker errors is a defect in the program.
//
// three's JSDoc also names its own classes in files that do not import them,
// and two of those names are lib.dom types too: `@param {Node} node` and
// `WeakMap<Node, Object>` across the node system (`NodeFrame.js` imports only
// `./constants.js`), and `@param {AudioListener} listener` in `Audio.js` and
// `PositionalAudio.js`. Inside three's source they mean three's classes, so
// they are realized there, as types only and with the text left as written.
// three's `{WebGLProgram}`, `{WebGLShader}` and `{AudioContext}` tags are not
// among them: those mean the browser objects.
const within = new Set(['three/src/**'])

export default function geatscPlugin() {
  return {
    name: 'unchecked-three',
    instantiate: () => ({
      ...inertPluginInstance,
      capabilities: {
        ...inertPluginInstance.capabilities,
        uncheckedJavaScript: new Set(['three/src/**']),
        ambientTypeRealizations: new Map([
          ['Node', { type: 'default', importedFrom: 'three/src/nodes/core/Node.js', within }],
          ['AudioListener', { type: 'AudioListener', importedFrom: 'three/src/audio/AudioListener.js', within }]
        ])
      }
    })
  }
}
