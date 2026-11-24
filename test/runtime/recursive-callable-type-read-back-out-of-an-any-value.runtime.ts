// A function type that names itself through its own result -- a step that
// resolves to a record holding the next step -- is one recursive callable
// carrier. Read back out of an `any` value it crosses the dynamic boundary
// as that callable, and calling it walks the chain.

type Step = (label: string) => Promise<{ text: string; next?: Step }>

const last: Step = async (label) => ({ text: `${label}:end` })
const first: Step = async (label) => ({ text: `${label}:start`, next: last })
const held: any = first

async function walk(): Promise<void> {
  let step: Step | undefined = held as Step
  const seen: string[] = []
  while (step) {
    const answer = await step(String(seen.length))
    seen.push(answer.text)
    step = answer.next
  }
  console.log(seen.join(' '))
}
void walk()
//! expect: 0:start 1:end
