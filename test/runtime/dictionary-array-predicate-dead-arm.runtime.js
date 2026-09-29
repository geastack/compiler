// @ts-nocheck
//! expect: f( p:a, q:b )
//! expect: missing b
//! expect: f( p:a, 0:b )
//! expect: missing a
//! expect: f( 0:a )
// `Array.isArray( parameters )` over a parameter bag the JSDoc states a
// string-keyed dictionary, and every caller passes one: three's
// `FunctionCallNode.generate` over `@type {Object<string, Node>}`. TypeScript
// narrows the true branch to `{ [x: string]: N } & any[]` rather than to
// `never`, and that branch writes `parameters.length = inputs.length`. Read
// as the plain dictionary, the write was a store of a number into the `N`
// slot (`conversion:scalar(number)->class-ref(N)`). No array is assignable to
// a string index signature and `Array.isArray` of a dictionary carrier is
// the constant `false`, so the branch never runs: its receiver is `never`
// (`derive.ts`'s `isDictionaryNarrowedToArray`), and a store through it is
// the TypeError PutValue throws for `undefined` (`emit-properties.ts`).
class N {
  /** @param {string} n */
  constructor(n) {
    this.n = n
  }

  /** @return {string} */
  build() {
    return this.n
  }
}

class Call {
  /**
   * @param {?N} fn - The function.
   * @param {Object<string, N>} [parameters={}] - The parameters.
   */
  constructor(fn = null, parameters = {}) {
    /** @type {?N} */
    this.fn = fn
    /** @type {Object<string, N>} */
    this.parameters = parameters
  }

  /**
   * @param {Array<N>} inputs
   * @return {string}
   */
  generate(inputs) {
    const params = []
    const parameters = this.parameters
    /** @type {( node: N, input: N ) => string} */
    const generateInput = (node, input) => node.build() + ':' + input.build()
    if (Array.isArray(parameters)) {
      if (parameters.length > inputs.length) {
        console.log('too many')
        parameters.length = inputs.length
      } else if (parameters.length < inputs.length) {
        console.log('too few')
        while (parameters.length < inputs.length) parameters.push(new N('0'))
      }
      for (let i = 0; i < parameters.length; i++) params.push(generateInput(parameters[i], inputs[i]))
    } else {
      for (const input of inputs) {
        const node = parameters[input.n]
        if (node !== undefined) {
          params.push(generateInput(node, input))
        } else {
          console.log('missing ' + input.n)
          params.push(generateInput(new N('0'), input))
        }
      }
    }
    return this.fn.build() + '( ' + params.join(', ') + ' )'
  }
}

const f = new N('f')
const inputs = [new N('a'), new N('b')]
console.log(new Call(f, { a: new N('p'), b: new N('q') }).generate(inputs))
console.log(new Call(f, { a: new N('p') }).generate(inputs))
console.log(new Call(f).generate([new N('a')]))
