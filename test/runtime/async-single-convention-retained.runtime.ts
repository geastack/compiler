//! emitted-lacks: gea::Task<
//! emitted-lacks: _task(

async function main(): Promise<void> {
  async function value(): Promise<number> {
    await undefined
    return 42
  }

  console.log(await value())
  const retained = value()
  retained.then((answer) => console.log(answer))
  console.log(await retained)
}

void main()
//! expect: 42
//! expect: 42
//! expect: 42
