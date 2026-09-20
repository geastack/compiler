import { OverlayAccessorBase } from './classes.js'

/** @param {OverlayAccessorBase} value */
export const readOverlayFields = (value) => [value.texture, value.overlayOnly]
