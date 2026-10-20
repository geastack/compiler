//! expect: the sound bank is unavailable
//! expect: code 42
//! emitted-has: gea::host::console::warn(

// Node writes `console.warn` to stderr exactly as it writes `console.error`;
// an app's recoverable load-failure paths call it, and each refused by name
// until the member had a row.
console.warn('the sound bank is unavailable')
console.warn('code', 42)
