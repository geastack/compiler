//! expect: recursive-derived=42
//! emitted-has: double gea_body_fn_decl_f168_22(gea::Ref<gea_class_decl_f168_1> gea_arg_0, long long gea_arg_1) {\ndouble v0;\nlong long b0;\ngea::Ref<gea_class_decl_f168_1> b1;\ndouble v8;\nb0 = gea_arg_1;\nb1 = ((gea_arg_0->children)->elementAt(0));\nif (!((b0) == (0))) goto block2;\nv0 = (gea_arg_0->value);\ngoto block3;\nblock2:\nv8 = gea_body_fn_decl_f168_22(std::move(b1), ((b0) - (1)));\nv0 = v8;\nblock3:\nreturn v0;\n}
// @ts-nocheck

// THE PIN IS THE DIRECT READ, NOT THE CARRIER.
//
// `children[0]` on `/** @type {[Object3D]} */` is a literal index into a
// CLOSED tuple at a non-optional position: it cannot be out of range and it
// cannot hold a hole, so the recursive call reads the child with one
// `elementAt(0)` and nothing else. It used to emit a presence test and an
// `Optional` round trip, because `structural-array-read.ts` proved the
// position present and then unioned `undefined` back in from the checker's
// own `any` -- one rule undoing the other, on a recursive hot path.
//
// The carrier is `ArrayObject`, not the positional record this pinned before
// `6d349ba72`: a homogeneous fixed-arity tuple and `T[]` are views of one JS
// array, and aliasing and `Array.prototype` dispatch are questions about the
// PHYSICAL element. The arity that proves this read present lives in the
// semantic tuple shape either way, which is exactly what the census asks.

class Object3D {
  /** @param {number} value */
  constructor(value) {
    this.value = value
    /** @type {[Object3D]} */
    this.children = [this]
  }
}

/** @param {number} depth @returns {number} */
function readRecursive(node, depth) {
  const alias = node
  const children = alias.children
  const child = children[0]
  return depth === 0 ? node.value : readRecursive(child, depth - 1)
}

console.log('recursive-derived=' + readRecursive(new Object3D(42), 3))
