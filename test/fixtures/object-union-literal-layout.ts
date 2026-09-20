interface LegacyEnvelope {
  $value: string
  $type: string
}

interface ModernEnvelope {
  $value: { text: string }
}

type Envelope = LegacyEnvelope | ModernEnvelope

const makeEnvelope = (modern: boolean): Envelope => {
  if (modern) return { $value: { text: 'modern' } }
  return { $value: 'legacy', $type: 'text' }
}

const legacy = makeEnvelope(false)
const modern = makeEnvelope(true)
console.log('$type' in legacy ? legacy.$value : 'wrong')
console.log('$type' in modern ? 'wrong' : modern.$value.text)
