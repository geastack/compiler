// @ts-nocheck
import Node from './_flip-install-node.js'
import FlipNode from './_flip-install-flip-node.js'

export function addMethodChaining(name, nodeElement) {
  Node.prototype[name] = function (...params) {
    return nodeElement(this, ...params)
  }
}

const parseSwizzle = (props) => props.replace(/r|s/g, 'x').replace(/g|t/g, 'y').replace(/b|p/g, 'z').replace(/a|q/g, 'w')
const parseSwizzleAndSort = (props) => parseSwizzle(props).split('').sort().join('')

function setProtoSwizzle(property, altA, altB) {
  const propUpper = property.toUpperCase()
  const altAUpper = altA.toUpperCase()
  const altBUpper = altB.toUpperCase()

  Node.prototype['flip' + propUpper] = Node.prototype['flip' + altAUpper] = Node.prototype['flip' + altBUpper] = function () {
    const swizzle = parseSwizzleAndSort(property)

    return new FlipNode(this, swizzle)
  }
}

const swizzleA = ['x', 'y', 'z', 'w']
const swizzleB = ['r', 'g', 'b', 'a']
const swizzleC = ['s', 't', 'p', 'q']

for (let a = 0; a < 4; a++) {
  let prop = swizzleA[a]
  let altA = swizzleB[a]
  let altB = swizzleC[a]

  setProtoSwizzle(prop, altA, altB)

  for (let b = 0; b < 4; b++) {
    prop = swizzleA[a] + swizzleA[b]
    altA = swizzleB[a] + swizzleB[b]
    altB = swizzleC[a] + swizzleC[b]

    setProtoSwizzle(prop, altA, altB)
  }
}

const ShaderNodeImmutable = function (NodeClass, ...params) {
  return new NodeClass(...params)
}

export const nodeImmutable = (NodeClass, ...params) => new ShaderNodeImmutable(NodeClass, ...params)

addMethodChaining('toVar', (node) => node)
