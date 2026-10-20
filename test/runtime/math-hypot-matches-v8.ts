//! expect: 0.5385164807134505 0.7810249675906655 1.077032961426901
//! expect: 0.3741657386773941 0.5830951894845301

// V8's own answers. A plain sum of squares misses the three-operand pair in
// the last bit, and a square fused into its add misses all three two-operand
// ones (0.5385164807134504, 0.7810249675906654, 1.0770329614269007 on arm64).
console.log(Math.hypot(0.5, 0.2), Math.hypot(0.6, 0.5), Math.hypot(1, 0.4))
console.log(Math.hypot(0.3, 0.2, 0.1), Math.hypot(0.4, 0.3, 0.3))
