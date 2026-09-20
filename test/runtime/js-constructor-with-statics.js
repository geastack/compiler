// TypeScript's JS expando inference makes `SourceNode.fromParts = ...` a
// DECLARATION of the `SourceNode` symbol. A second declaration is not a second
// overload: reading the one signature off the body alone threw away the
// construct signature the checker attached to the symbol, and the
// declaration's own cell then disagreed with every reference to it
// (`structural-declarations.ts`'s `implementationSignatureOf`).
//
// This is how the `source-map` package writes SourceNode's statics, and how
// JavaScript wrote classes before `class`. The prototype-method half of that
// idiom (`SourceNode.prototype.add = function () {}`) is deliberately NOT
// here: a read of such a method through an instance refuses by name
// (`producers/properties.ts`'s `jsConstructorPrototypeMemberRefusalOf`) until
// a pre-class constructor is modelled as the class it is. Before that refusal
// the method was a struct field nothing ever wrote, and calling it segfaulted.

/**
 * @param {number} line
 * @param {string} source
 */
function SourceNode(line, source) {
  /** @type {string[]} */
  this.children = []
  this.line = line
  this.source = source
}

/** @param {number} line */
SourceNode.fromParts = function SourceNode_fromParts(line) {
  var node = new SourceNode(line, 'x.js')
  node.children.push('p')
  return node
}

var made = SourceNode.fromParts(3)
console.log(made.line, made.source, made.children.length, made.children[0])

var direct = new SourceNode(9, 'y.js')
direct.children.push('a')
direct.children.push('b')
console.log(direct.line, direct.children.length)

//! expect: 3 x.js 1 p
//! expect: 9 2
