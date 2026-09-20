//! oracle-expect: compile-1:19|sweep-2:8|report-3:9|plugins=11:alpha,beta|issued=3
import { installDefaults, issuedCount, registered, runBatch, type Job } from './index.js'

export function main(): string {
  const pluginScore = installDefaults()
  const jobs: Job[] = [
    { name: 'compile', priority: 4, tags: ['urgent', 'batch'] },
    { name: 'sweep', priority: 2, tags: ['batch'] },
    { name: 'report', priority: 3, tags: [] }
  ]
  return runBatch(jobs) + '|plugins=' + String(pluginScore) + ':' + registered() + '|issued=' + String(issuedCount())
}

console.log(main())
