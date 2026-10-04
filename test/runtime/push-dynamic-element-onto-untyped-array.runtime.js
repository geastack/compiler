// @ts-nocheck
//! expect: viewports 2 10,20 30,40
//! expect: descriptors 1 d0
// XRManager's `_getWebGPUViewData`: `viewports: []` in an object literal is an
// untyped array, and each pushed `gpuSubImage.viewport` is read off an `any`
// binding. ECMA-262 23.1.3.23 appends each argument in order and returns the
// new length, whatever the receiver's elements are.
const binding = JSON.parse('{"subImages":[{"viewport":[10,20]},{"viewport":[30,40],"descriptor":"d0"}]}')
const viewData = { colorTexture: null, viewDescriptors: [], viewports: [] }
for (let i = 0; i < 2; i++) {
  const gpuSubImage = binding.subImages[i]
  viewData.viewports.push(gpuSubImage.viewport)
  if (gpuSubImage.descriptor) viewData.viewDescriptors.push(gpuSubImage.descriptor)
}
console.log('viewports', viewData.viewports.length, viewData.viewports[0].join(','), viewData.viewports[1].join(','))
console.log('descriptors', viewData.viewDescriptors.length, viewData.viewDescriptors[0])
