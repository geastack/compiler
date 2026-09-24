// three.js's own WebGPURenderer, as an app writes it, compiled from three's
// source with nothing edited. `scripts/three-webgpu-coverage.mjs` builds it;
// that script's comment says what it resolves `three/webgpu` to and why.

import '@geastack/native-webgpu'
import { BoxGeometry, Mesh, MeshStandardNodeMaterial, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'

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
