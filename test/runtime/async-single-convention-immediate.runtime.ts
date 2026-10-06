//! emitted-has: gea::Task<double>
//! emitted-has: gea::Task<void>
//! emitted-lacks: _task(

async function main(): Promise<void> {
  async function value(failBefore: boolean, failAfter: boolean): Promise<number> {
    try {
      if (failBefore) throw new Error('expected before suspension')
      await undefined
      if (failAfter) throw new Error('expected after suspension')
      return 42
    } finally {
      console.log('finally')
    }
  }

  async function nothing(): Promise<void> {
    await undefined
    console.log('nothing')
  }

  console.log(await value(false, false))

  for (let index = 0; index < 2; index += 1) {
    try {
      await value(index === 0, index === 1)
    } catch (error) {
      console.log('caught')
    }
  }
  await nothing()
}

void main()
//! expect: finally
//! expect: 42
//! expect: finally
//! expect: caught
//! expect: finally
//! expect: caught
//! expect: nothing
