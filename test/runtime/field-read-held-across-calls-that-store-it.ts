// A field read held across later statements names the field only while
// nothing in between can store that key: a call that replaces the field (or
// may, through a method or a callback) must leave the earlier read holding
// the object it saw, which the replacement may have released.
class Fog {
  constructor(readonly name: string) {}
}

class Scene {
  fog: Fog | null = new Fog('first')
  background: Fog = new Fog('sky')
}

class Swapper {
  swap(scene: Scene): void {
    scene.fog = new Fog('swapped')
  }
  look(scene: Scene): number {
    return scene.background.name.length
  }
}

function replaceFog(scene: Scene): void {
  scene.fog = new Fog('replaced')
}

function untouched(scene: Scene): number {
  return scene.background.name.length
}

function readAcrossDirectStore(scene: Scene): string {
  const fog = scene.fog
  scene.fog = null
  return fog === null ? 'none' : fog.name
}

function readAcrossCallThatStores(scene: Scene): string {
  const fog = scene.fog
  replaceFog(scene)
  return (fog === null ? 'none' : fog.name) + '>' + (scene.fog === null ? 'none' : scene.fog.name)
}

function readAcrossMethodThatStores(scene: Scene, swapper: Swapper): string {
  const fog = scene.fog
  swapper.swap(scene)
  return fog === null ? 'none' : fog.name
}

function readAcrossCallback(scene: Scene, callback: (scene: Scene) => void): string {
  const fog = scene.fog
  callback(scene)
  return fog === null ? 'none' : fog.name
}

function readAcrossCallsThatDoNotStore(scene: Scene, swapper: Swapper): string {
  const fog = scene.fog
  const sum = untouched(scene) + swapper.look(scene)
  return (fog === null ? 'none' : fog.name) + ':' + sum
}

function readInLoop(scenes: Scene[]): string {
  let out = ''
  for (const scene of scenes) {
    const fog = scene.fog
    if (fog !== null) out += fog.name + ','
    replaceFog(scene)
    if (fog !== null) out += fog.name + ';'
  }
  return out
}

const swapper = new Swapper()
console.log(readAcrossDirectStore(new Scene()))
console.log(readAcrossCallThatStores(new Scene()))
console.log(readAcrossMethodThatStores(new Scene(), swapper))
console.log(
  readAcrossCallback(new Scene(), (scene) => {
    scene.fog = new Fog('from callback')
  })
)
console.log(readAcrossCallsThatDoNotStore(new Scene(), swapper))
console.log(readInLoop([new Scene(), new Scene()]))
