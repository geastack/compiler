//! emitted-lacks: gea::Task<
//! emitted-lacks: _task(

async function main(): Promise<void> {
  const answer = 42

  async function captured(): Promise<number> {
    await undefined
    return answer
  }

  async function recursive(n: number): Promise<number> {
    await undefined
    return n > 0 ? await recursive(n - 1) : 42
  }

  async function adopted(): Promise<number> {
    await undefined
    return Promise.resolve(42)
  }

  async function fromSync(): Promise<number> {
    await undefined
    return 42
  }

  function syncCaller(): Promise<number> {
    return fromSync()
  }

  console.log(await captured())
  console.log(await recursive(2))
  console.log(await adopted())
  console.log(await fromSync())
  console.log(await syncCaller())
}

void main()
//! expect: 42
//! expect: 42
//! expect: 42
//! expect: 42
//! expect: 42
