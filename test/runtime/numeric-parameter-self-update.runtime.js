function wrap(t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  return t
}

function amplify(t) {
  t += t
  return t
}

console.log(wrap(-0.25))
console.log(wrap(1.25))
console.log(wrap(0.5))
console.log(amplify(3))
