interface Step {
  name: string
  value: number
}

async function score(step: Step): Promise<string> {
  const shifted = await Promise.resolve(step.value + step.name.length)
  return Promise.resolve(shifted).then((value) => step.name + '=' + value * 2)
}

async function workflow(steps: Step[]): Promise<string> {
  const audit: string[] = []
  const labels = await Promise.all(steps.map((step) => score(step)))
  await Promise.resolve('queued').then((state) => {
    audit.push(state)
  })
  for (const label of labels) {
    if (label.indexOf('beta') >= 0) audit.push('hit:' + label)
  }
  return labels.join('|') + ' audit=' + audit.join(',')
}

export async function main(): Promise<string> {
  return await workflow([
    { name: 'alpha', value: 3 },
    { name: 'beta', value: 5 },
    { name: 'gamma', value: 2 }
  ])
}

main().then((value) => {
  console.log(value)
})
