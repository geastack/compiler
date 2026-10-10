// A NAMED OPTIONS RECORD HANDED TO A `Narrower | null = null` PARAMETER.
//
// A database client's `Topology` constructor passes its whole `TopologyOptions` to
// `new TopologyDescription(..., options)`, whose last formal is
// `TopologyDescriptionOptions | null = null`: a different named interface
// declaring two of the source's members as optional, under a nullable,
// defaulted envelope. The record must reach the present arm as a view of the
// fields the narrower interface declares.

interface DescriptionOptions {
  heartbeatFrequencyMS?: number
  localThresholdMS?: number
}

interface ServerLikeOptions {
  heartbeatFrequencyMS: number
  connectTimeoutMS: number
}

interface TopologyLikeOptions extends ServerLikeOptions {
  hosts: string[]
  retryWrites: boolean
  replicaSet?: string
}

class Description {
  heartbeat: number
  threshold: number
  setName: string | null
  constructor(kind: number, setName: string | null = null, options: DescriptionOptions | null = null) {
    options = options ?? {}
    this.heartbeat = (options.heartbeatFrequencyMS ?? 0) + kind
    this.threshold = options.localThresholdMS ?? 15
    this.setName = setName ?? null
  }
}

function describeTopology(options: TopologyLikeOptions): Description {
  return new Description(1, options.replicaSet, options)
}

const plain: TopologyLikeOptions = { heartbeatFrequencyMS: 500, connectTimeoutMS: 10, hosts: ['a', 'b'], retryWrites: true }
const named: TopologyLikeOptions = { heartbeatFrequencyMS: 250, connectTimeoutMS: 10, hosts: [], retryWrites: false, replicaSet: 'rs0' }
const first = describeTopology(plain)
const second = describeTopology(named)
const bare = new Description(2)
console.log(`${first.heartbeat}:${first.threshold}:${first.setName}`)
console.log(`${second.heartbeat}:${second.threshold}:${second.setName}`)
console.log(`${bare.heartbeat}:${bare.threshold}:${bare.setName}`)
console.log(plain.hosts.length)
//! expect: 501:15:null
//! expect: 251:15:rs0
//! expect: 2:15:null
//! expect: 2
