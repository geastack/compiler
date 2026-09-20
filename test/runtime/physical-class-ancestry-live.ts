class RuntimeBase {
  inherited = 7
}

class RuntimeDerived extends RuntimeBase {
  own = 11
}

function readBase(value: RuntimeBase): number {
  return value.inherited
}

const value = new RuntimeDerived()
console.log(readBase(value), value.inherited, value.own)
