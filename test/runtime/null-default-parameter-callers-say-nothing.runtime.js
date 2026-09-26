// @ts-nocheck
//! expect: plain:a x:b
//! expect: analyze text:c
//! expect: e:4 f:fresh
// A parameter typed by nothing but its `null` default, whose callers leave it
// out or pass what the census cannot bind (three's `Node.analyze( builder,
// output = null )` once its contradicted tag is gone, called only as
// `this.analyze( builder, output )` with `build`'s own `?(string|Node)`): the
// body reads it as the dynamic carrier, and the ABI slot has to hold the same
// carrier or the convention is refused.
class Label {
  constructor(text) {
    this.text = text
  }
}
function describe(value, settings = null) {
  if (settings !== null) return settings.text + ':' + value
  return 'plain:' + value
}
console.log(describe('a') + ' ' + describe('b', new Label('x')))
class Step {
  /**
   * @param {string} stage
   * @param {?(string|Label)} [output=null]
   * @return {string}
   */
  build(stage, output = null) {
    if (stage === 'analyze') return this.analyze(stage, output)
    return stage
  }
  analyze(stage, output = null) {
    if (output === null) return stage + ' none'
    return stage + ' ' + (typeof output === 'string' ? output : 'text:' + output.text)
  }
}
console.log(new Step().build('analyze', new Label('c')))
class Target {
  constructor(size) {
    this.size = size
  }
}
class Pmrem {
  fromSource(source, target = null) {
    return target === null ? source + ':fresh' : source + ':' + target.size
  }
}
let generator = null
const cached = [undefined, new Target(4)]
const convert = (source, index) => {
  if (generator === null) generator = new Pmrem()
  const cache = cached[index]
  return generator.fromSource(source, cache)
}
console.log(convert('e', 1) + ' ' + convert('f', 0))
// A mention by name the census cannot count keeps the method open.
const loose = JSON.parse('null')
if (loose) loose.fromSource('g')
