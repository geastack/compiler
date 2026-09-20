import { NativeHandle, NativeShader, NativeProgram } from '@geastack/native-webgl-angle/nativeWebGL'

function textureIdentity(texture: WebGLTexture | null): WebGLTexture | null {
  return texture
}

function shaderIdentity(shader: WebGLShader): WebGLShader {
  return shader
}

function programIdentity(program: WebGLProgram): WebGLProgram {
  return program
}

const texture = new NativeHandle('texture', 17)
const shader = new NativeShader(19, 35633)
const program = new NativeProgram(23)
console.log(textureIdentity(texture) === texture, textureIdentity(null) === null)
console.log(shaderIdentity(shader) === shader, programIdentity(program) === program)
console.log(typeof WebGLRenderingContext === 'undefined')
console.log(
  typeof HTMLCanvasElement === 'undefined',
  typeof OffscreenCanvas === 'undefined',
  // @ts-expect-error The checker library does not yet declare Float16Array.
  typeof Float16Array === 'undefined'
)
