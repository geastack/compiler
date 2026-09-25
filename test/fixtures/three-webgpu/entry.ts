// three.js's own WebGPURenderer, as an app writes it, compiled from three's
// source with nothing edited. `scripts/three-webgpu-coverage.mjs` builds it
// through gea's pipeline; that script's comment says how.
//
// Each class comes from its own module under `three/src/`, the way Skytail
// imports three, not from `three/webgpu`. Vite resolves `three/webgpu` through
// three's `exports` to `build/three.webgpu.js`, one bundle of all of three with
// no source map: the module graph cannot drop a module of it, and every row
// names a bundle line. From the source modules the graph keeps what the entry
// reaches and nothing else (no `loaders/`, no `audio/`).

import '@geastack/native-webgpu'
import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js'
import { BoxGeometry } from 'three/src/geometries/BoxGeometry.js'
import MeshStandardNodeMaterial from 'three/src/materials/nodes/MeshStandardNodeMaterial.js'
import { Mesh } from 'three/src/objects/Mesh.js'
import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js'
import { Scene } from 'three/src/scenes/Scene.js'

const scene = new Scene()
const camera = new PerspectiveCamera(60, 4 / 3, 0.1, 100)
camera.position.z = 3
// three declares `Object3D.raycast( /* raycaster, intersects */ )` with its
// parameters commented out, so the checker types it `() => void` and rejects a
// Mesh, whose raycast takes two, as an Object3D. three's files are unchecked;
// this one is not, and the error says nothing about the program.
// @ts-expect-error
scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial()))

const renderer = new WebGPURenderer()
renderer.init().then(() => renderer.render(scene, camera))
