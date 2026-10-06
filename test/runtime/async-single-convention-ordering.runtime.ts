//! emitted-has: gea::Task<double>
//! emitted-lacks: _task(

async function main(): Promise<void> {
  async function value(suspend: boolean): Promise<number> {
    if (suspend) await undefined
    Promise.resolve().then(() => console.log('settled'))
    return 42
  }

  Promise.resolve().then(() => console.log('before'))
  console.log(await value(false))

  for (let index = 0; index < 2; index += 1) {
    Promise.resolve().then(() => console.log('between'))
    console.log(await value(true))
  }
}

void main()
//! expect: before
//! expect: settled
//! expect: 42
//! expect: between
//! expect: settled
//! expect: 42
//! expect: between
//! expect: settled
//! expect: 42
