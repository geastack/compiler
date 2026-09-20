import { value } from '@app/value'
import { version } from 'node:process'

console.log(version.length > 0 ? value + 1 : 0)
