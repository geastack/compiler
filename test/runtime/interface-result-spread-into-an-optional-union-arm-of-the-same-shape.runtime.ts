// A provider map's entry is a union of credential shapes (or an empty
// object to request fetching); the fetched token is declared by its own
// interface with the same single field. Spreading the map and adding the
// token stores the token under the entry, in the arm of its own shape: the
// empty-table arm holds no field, so it is no home for it.

export {}

interface AccessToken {
  accessToken: string
}

interface CacheEntry extends AccessToken {
  accessToken: string
  expiresOnTimestamp: number
}

type AzureConfiguration = { tenantId: string; clientId: string; clientSecret: string } | { accessToken: string }

interface Providers {
  azure?: AzureConfiguration | Record<string, never>
  local?: { key: string }
}

class Cache {
  cached: CacheEntry | null = null
  async getToken(): Promise<AccessToken> {
    if (this.cached === null) this.cached = { accessToken: 'tok', expiresOnTimestamp: 10 }
    return this.cached
  }
}

const cache = new Cache()

async function load(providers: Providers): Promise<Providers> {
  const azure = await cache.getToken()
  return { ...providers, azure }
}

load({ azure: {}, local: { key: 'k' } }).then((loaded) => {
  console.log(loaded.azure !== undefined, loaded.local?.key)
})

//! expect: true k
