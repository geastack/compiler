// Every refusal kind the C++ target can throw must be a capability key.
//
// Counted by stage, against the single-census invariants: 675 `createCppEmitBlockedError`
// sites once refused with kind strings drawn from no namespace certification
// knew, so a certified program could be refused at emission by a key nothing
// certified. Since 2.3 a kind is a `CapabilityKey` (`src/ir/certify.ts`):
// `<family>:<discriminator>` with the family one of `capabilityFamilies`. This
// script is the mechanical half of that rule and must print nothing but its
// summary line: `tsc` types the parameter, and this catches what a type cannot
// -- a template literal whose family prefix is computed, or a kind passed
// through a variable so the literal never reaches the factory's parameter.
//
// Read from the source tree, not from `dist/`: the kinds are string literals
// and the family list is a string literal array, so the question is answerable
// without compiling anything.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not `.pathname`: on Windows the latter keeps the URL's
// leading slash, and `/C:/...` joins into `C:\C:\...`.
const here = fileURLToPath(new URL('..', import.meta.url))
const target = join(here, 'src', 'targets', 'cpp')

const sourcesUnder = (root) => {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path)
    }
  }
  walk(root)
  return out
}

// The one family list, read off `certifyIr`'s own declaration so the script
// and the type cannot drift: a family added to one is added to the other.
const certifyText = readFileSync(join(here, 'src', 'ir', 'certify.ts'), 'utf8')
const familiesBlock = certifyText.match(/export const capabilityFamilies = \[([^\]]*)\]/)
if (!familiesBlock) throw new Error('src/ir/certify.ts no longer declares `capabilityFamilies`')
const families = new Set([...familiesBlock[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]))

// `createCppEmitBlockedError(<kind>, ...)`. A plain string literal must spell
// `family:...`; a template literal must START with `family:` before its first
// `${}` so the family is decided by the author, not by a runtime value; anything
// else (an identifier, a call, a member read) is a kind decided at emission
// time, which is exactly what the union exists to forbid.
const findings = []
let sites = 0
for (const file of sourcesUnder(target)) {
  const text = readFileSync(file, 'utf8')
  const pattern = /createCppEmitBlockedError\(\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^,)]+)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    sites += 1
    const argument = match[1].trim()
    const where = `${relative(here, file)}:${text.slice(0, match.index).split('\n').length}`
    const quoted = argument.match(/^'((?:[^'\\]|\\.)*)'$/)
    const templated = argument.match(/^`([^$`]*)/)
    const prefix = quoted ? quoted[1] : templated && argument.startsWith('`') ? templated[1] : null
    if (prefix === null) {
      findings.push(`${where}: non-literal kind ${argument}`)
      continue
    }
    const family = prefix.slice(0, prefix.indexOf(':'))
    if (!prefix.includes(':') || !families.has(family)) findings.push(`${where}: kind "${prefix}" is outside the capability families`)
  }
}

console.log(`createCppEmitBlockedError sites: ${sites}; outside the key union: ${findings.length}`)
for (const finding of findings) console.log(`  ${finding}`)
process.exitCode = findings.length === 0 ? 0 : 1
