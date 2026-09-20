class Uniform {
  value: number

  constructor(value: number) {
    this.value = value
  }
}

const normalizedLengths = (uniformsSource: Uniform[]): boolean => {
  let valid = true
  for (let i = 0; i < uniformsSource.length; i++) {
    const uniforms = Array.isArray(uniformsSource[i]!) ? uniformsSource[i]! : [uniformsSource[i]!]
    // @ts-ignore TypeScript intentionally retains the unnormalized union; this fixture verifies the compiler's construction proof.
    if (uniforms.length !== 1) valid = false
  }
  return valid
}

console.log(normalizedLengths([new Uniform(4), new Uniform(9)]))
