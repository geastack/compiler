//! expect: set:a,b
//! expect: stack:n
//! expect: view
//! expect: bytes
//! expect: pattern is a view: false

// three's NodeBuilder.getClosestSubBuild takes `Node | Set<string> |
// Array<string>` and asks `data instanceof Set`; its utils.isTypedArray asks
// `array instanceof DataView` of whatever `ArrayBuffer.isView` accepted. A Set
// is one keyed-collection family and a DataView one byte-view carrier, so the
// union's discriminant answers both, and a host record of any other layout is
// settled false without a read.
class Stack {
  readonly subBuild = 'n'
}

const closest = (data: Stack | Set<string>): string => (data instanceof Set ? `set:${[...data].join(',')}` : `stack:${data.subBuild}`)

const describeView = (view: DataView | Uint8Array): string => (view instanceof DataView ? 'view' : 'bytes')

const patternIsView = (value: RegExp): boolean => value instanceof DataView

console.log(closest(new Set(['a', 'b'])))
console.log(closest(new Stack()))
console.log(describeView(new DataView(new ArrayBuffer(4))))
console.log(describeView(new Uint8Array(2)))
console.log(`pattern is a view: ${patternIsView(/a/)}`)
