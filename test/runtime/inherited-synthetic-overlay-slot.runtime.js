class SyntheticOverlayObject {}

class SyntheticOverlayBase {
  /** @type {string | number | SyntheticOverlayObject | undefined}
   * @geaSubclassMemberOverlay */
  color
}

class SyntheticOverlayDerived extends SyntheticOverlayBase {
  /** @type {number} */
  color = 0xffffff
}

/** @param {SyntheticOverlayBase} value */
const readSyntheticOverlayBase = (value) => {
  const color = value.color
  return typeof color === 'number' ? color : -1
}

const syntheticOverlayDerived = new SyntheticOverlayDerived()

//! expect: synthetic-overlay=16777215/16777215
console.log(`synthetic-overlay=${readSyntheticOverlayBase(syntheticOverlayDerived)}/${syntheticOverlayDerived.color}`)
