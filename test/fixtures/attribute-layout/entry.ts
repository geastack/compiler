// A vertex-layout loop over a geometry that holds both a plain and an
// interleaved attribute, in the shape of a renderer's render object:
// `this.geometry`'s bare `@type {BufferGeometry}` names a class the file never
// imports; `object.geometry` is declared only by a subclass (Mesh); the
// `@type`/`@return` tags say `Array<BufferAttribute>` while the geometry holds
// an InterleavedBufferAttribute; and Texture's `offset` is overlaid on the
// EventDispatcher base that BufferAttribute shares.
import { BufferGeometry } from './vendor/attrlib/src/BufferGeometry.js'
import { BufferAttribute } from './vendor/attrlib/src/BufferAttribute.js'
import { InterleavedBuffer } from './vendor/attrlib/src/InterleavedBuffer.js'
import { InterleavedBufferAttribute } from './vendor/attrlib/src/InterleavedBufferAttribute.js'
import { Mesh } from './vendor/attrlib/src/Mesh.js'
import { Texture } from './vendor/attrlib/src/Texture.js'
import RenderObject from './vendor/attrlib/src/RenderObject.js'
import AttributeUtils from './vendor/attrlib/src/AttributeUtils.js'

const geometry = new BufferGeometry()
geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3))
geometry.setAttribute('uv', new InterleavedBufferAttribute(new InterleavedBuffer(new Float32Array(8), 4), 2, 2))
const mesh = new Mesh(geometry)
const renderObject = new RenderObject(mesh, ['position', 'uv', 'normal'])
const utils = new AttributeUtils()
const texture = new Texture()
console.log(
  String(utils.vertexLayout(renderObject)) + ' ' + String(renderObject.getVertexBuffers().length) + ' ' + String(texture.offset.x)
)
