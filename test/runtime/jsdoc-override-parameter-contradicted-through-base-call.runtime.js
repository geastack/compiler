// @ts-nocheck
//! expect: mesh wgsl
// A call through a base method runs the override: three's NodeManager calls
// `this.backend.createNodeBuilder( renderObject.object, ... )`, which resolves
// to `Backend.createNodeBuilder()` with no parameters, and `WebGPUBackend`'s
// override tags its parameter `@param {RenderObject} object` and hands it to
// `new WGSLNodeBuilder( object )` under `@param {Object3D} object`. The
// argument, an `Object3D`, contradicts the override's tag; the override's
// parameter, whose tag is blanked, is no evidence against the builder's.
import Object3D from './_base-call-object.js'
import RenderObject from './_base-call-render-object.js'
import { WebGPUBackend } from './_base-call-backends.js'
import Renderer from './_base-call-renderer.js'

const renderer = new Renderer(new WebGPUBackend())
console.log(renderer.build(new RenderObject(new Object3D('mesh'))))
