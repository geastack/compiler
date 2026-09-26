// @ts-nocheck
//! expect: tex:1:4 tex-msaa:4:4 tex:1:4 | tex 1 true false false | label,size,sampleCount,format,extra 5
//! emitted-has: gea::record::assignNativeExpandoProperties
// `Object.assign( {}, instance )` makes a plain object holding the instance's
// own keys, never an instance of its class: no `reset`, `instanceof` false.
// The checker types the copy as the class. three's
// `WebGPUTextureUtils.createTexture` copies its GPUTextureDescriptor this way
// for the MSAA texture and hands both to a dynamic GPU device.
class Descriptor {
  constructor() {
    this.label = ''
    this.size = { width: 0, height: 1 }
    this.sampleCount = 1
    this.format = undefined
  }
  reset() {
    this.label = ''
  }
}
const device = /** @type {any} */ ({
  createTexture: (d) => d.label + ':' + d.sampleCount + ':' + d.size.width
})
class Utils {
  createTexture(name, msaa) {
    const desc = new Descriptor()
    desc.label = name
    desc.size.width = 4
    const out = [device.createTexture(desc)]
    if (msaa) {
      const copy = Object.assign({}, desc)
      copy.label = copy.label + '-msaa'
      copy.sampleCount = 4
      out.push(device.createTexture(copy))
    }
    return out.join(' ')
  }
}
const utils = new Utils()
const report = utils.createTexture('tex', true) + ' ' + utils.createTexture('tex', false)
const source = new Descriptor()
source.label = 'tex'
source.extra = 5
const copy = Object.assign({}, source)
copy.sampleCount = 4
console.log(
  report,
  '|',
  source.label,
  source.sampleCount,
  copy.size === source.size,
  copy instanceof Descriptor,
  'reset' in copy,
  '|',
  Object.keys(copy).join(','),
  copy.extra
)
