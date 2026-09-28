//! expect: true false true
// ajv's `CodeGen._endBlockNode(N1: EndBlockNodeType, N2?: EndBlockNodeType)`:
// `n instanceof N1` where the right-hand side is a union of class
// constructors. The live arm names the class the node is tested against.
class BlockNode {
  readonly depth: number = 0
}
class If extends BlockNode {
  static readonly kind = 'if'
}
class Else extends BlockNode {
  static readonly kind = 'else'
}
class For extends BlockNode {
  static readonly kind = 'for'
}
type EndBlockNodeType = typeof If | typeof For
class CodeGen {
  current: BlockNode = new BlockNode()
  open(node: BlockNode): CodeGen {
    this.current = node
    return this
  }
  endsBlock(N1: EndBlockNodeType, N2?: EndBlockNodeType): boolean {
    const n = this.current
    return n instanceof N1 || (N2 !== undefined && n instanceof N2)
  }
  endIf(): boolean {
    return this.endsBlock(If)
  }
  endFor(): boolean {
    return this.endsBlock(For, If)
  }
}
const gen = new CodeGen()
console.log(gen.open(new If()).endIf(), gen.open(new Else()).endFor(), gen.open(new For()).endFor())
