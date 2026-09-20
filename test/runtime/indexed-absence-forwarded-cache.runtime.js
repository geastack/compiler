class Context {
  TEXTURE_2D = 3553
}

class Holder {
  cache = {}
}

function write(cache, index) {
  cache[index] = 1
}

function forward(cache) {
  write(cache, 0)
}

function convert(context, value) {
  return context[value] !== undefined ? context[value] : null
}

const holders = [new Holder()]
for (const holder of holders) {
  forward(holder.cache)
  console.log(holder.cache[0])
}
console.log(convert(new Context(), 1))
