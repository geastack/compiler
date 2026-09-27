// @ts-nocheck
//! expect: srgb 2 srgb
//! expect: linear srgb-linear,srgb
// three's `ColorManagement`: an object literal whose member `spaces: {}` is
// only ever read and written through a runtime key (`this.spaces[ name ]`)
// and filled by `Object.assign( this.spaces, colorSpaces )` from a parameter
// no caller types. The member is the same string-keyed table every
// `this.spaces[ ... ]` read already takes, not the checker's empty `{}`
// record, and the copy unboxes each source value into that table's value
// type, one store per key.
const SRGB = 'srgb',
  LIN = 'srgb-linear'
function createColorManagement() {
  const ColorManagement = {
    enabled: true,
    workingColorSpace: LIN,
    spaces: {},
    /** @param {string} colorSpace */
    getTransfer: function (colorSpace) {
      return this.spaces[colorSpace].transfer
    },
    getPrimaries: function (colorSpace) {
      return this.spaces[colorSpace].primaries
    },
    _getUnpackColorSpace: function (colorSpace = this.workingColorSpace) {
      return this.spaces[colorSpace].workingColorSpaceConfig.unpackColorSpace
    },
    define: function (colorSpaces) {
      Object.assign(this.spaces, colorSpaces)
    }
  }
  const P = [0.64, 0.33]
  ColorManagement.define({
    [LIN]: { primaries: P, transfer: 'linear', workingColorSpaceConfig: { unpackColorSpace: SRGB } },
    [SRGB]: { primaries: P, transfer: 'srgb' }
  })
  return ColorManagement
}
const ColorManagement = createColorManagement()
console.log(ColorManagement.getTransfer(SRGB), ColorManagement.getPrimaries(LIN).length, ColorManagement._getUnpackColorSpace())
console.log(ColorManagement.getTransfer(LIN), Object.keys(ColorManagement.spaces).join(','))
export {}
