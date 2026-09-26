//! expect: dev3 omitted3 dev3 none3
// three's `getFormat( texture, device )` (`renderers/webgpu/utils/WebGPUTextureUtils.js`)
// under `@param {GPUDevice} [device]`, and `pointShadow( light, shadow )`
// (`nodes/lighting/PointShadowNode.js`) under `@param {?PointLightShadow} [shadow=null]`.
// Neither file imports the tag's name, so the program-wide JSDoc census names
// the type; a `[name]` tag still lets a caller omit the argument, so the body
// binds `T | undefined`, the same slot the function value's calling convention states.
import { Device, Texture } from './_jsdoc-unimported-optional-types.js';
import { getFormat, pointShadow } from './_jsdoc-unimported-optional-util.js';

const texture = new Texture();
const device = new Device();
const format = getFormat;
console.log( getFormat( texture, device ), pointShadow( texture ), format( texture, device ), format( texture ) );
