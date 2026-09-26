// @ts-nocheck
//! expect: 5 3
// three's `overloadingFn` (`nodes/utils/FunctionOverloadingNode.js`) states
// `@returns {FunctionOverloadingNode}` and returns an arrow: the tag describes
// what the arrow produces when called, not the arrow. In an unchecked file a
// returned function contradicts a tag no function satisfies, so the tag is
// blanked and the call's result is the arrow itself.
class FunctionOverloadingNode {
  constructor(functionNodes, ...parametersNodes) {
    this.count = functionNodes.length + parametersNodes.length
  }
}
const overloadingBaseFn = (functionNodes, ...params) => new FunctionOverloadingNode(functionNodes, ...params)
/**
 * @param {Array<number>} functionNodes
 * @returns {FunctionOverloadingNode}
 */
const overloadingFn =
  (functionNodes) =>
  (...params) =>
    overloadingBaseFn(functionNodes, ...params)
const pick = overloadingFn([1, 2])
console.log(pick(1, 2, 3).count, pick(4).count)
