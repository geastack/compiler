//! emitted-lacks: gea::Task<
//! emitted-lacks: _task(

function consume(fn: () => Promise<number>): void {
  fn().then((answer) => console.log(answer))
}

async function main(): Promise<void> {
  async function value(): Promise<number> {
    await undefined
    return 42
  }

  console.log(await value())
  consume(value)
}

void main()
//! expect: 42
//! expect: 42
