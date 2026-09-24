import { Compatibility, Compatibility as Renamed, Parsed } from './constants.js';

/** @type {Object} */
export const imported = { [ Compatibility.TEXTURE_COMPARE ]: true };

/** @type {Object} */
export const renamed = { [ Renamed.TEXTURE_COMPARE ]: true };

/** @type {Object} */
export const opaque = { [ Parsed.TEXTURE_COMPARE ]: true };
