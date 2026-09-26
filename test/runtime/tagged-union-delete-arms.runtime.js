// @ts-nocheck
//! expect: true 2 | false false | true 2 | false false
// A `delete` on a value that is a class instance or a record deletes from
// whichever arm it holds. three's Renderer.highPrecision deletes
// `modelViewMatrix` off a context value that is a Node or a lighting record.
class GraphNode {
  constructor(name) {
    this.name = name
  }
}
/**
 * @param {GraphNode | { radiance: number }} data
 * @param {boolean} on
 */
function highPrecision(data, on) {
  if (on) {
    data.modelViewMatrix = 1
  } else {
    delete data.modelViewMatrix
  }
  return data.modelViewMatrix === 1
}
/** @param {GraphNode | { radiance: number }} data */
const report = (data) => highPrecision(data, true) + ' ' + Object.keys(data).length
const node = new GraphNode('n')
const record = { radiance: 2 }
console.log(
  report(node),
  '|',
  highPrecision(node, false),
  'modelViewMatrix' in node,
  '|',
  report(record),
  '|',
  highPrecision(record, false),
  'modelViewMatrix' in record
)
