//! expect: 7
//! expect: 9
//! expect: 11
//! expect: 0
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

class Material {
  run: () => number
  constructor(run: () => number) {
    this.run = run
  }
}

class Holder {
  material: Material | Material[] | null
  constructor(material: Material | Material[] | null = new Material(() => 7)) {
    this.material = material
  }
}

function score(holder: Holder): number {
  const material = holder.material
  if (material === null) return 0
  if (Array.isArray(material)) return material[0]!.run()
  return material.run()
}

console.log(score(new Holder()))
console.log(score(new Holder(new Material(() => 9))))
console.log(score(new Holder([new Material(() => 11)])))
console.log(score(new Holder(null)))
