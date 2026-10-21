// @ts-nocheck
// Replaces a hook from JavaScript, where the parameters are untyped.
export function installUntyped(target, log) {
  target.onBeforeCompile = (shader, renderer) => log('untyped ' + Object.keys(shader.uniforms).join(',') + ' ' + typeof renderer)
}
