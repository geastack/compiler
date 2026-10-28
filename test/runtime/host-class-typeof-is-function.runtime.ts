// A host class is carried as a native handle with a call or construct half.
// It has [[Call]], so `typeof` answers "function" (ECMA-262 13.5.3), and a
// feature test on it takes the branch it takes in JavaScript.
//! expect: function function function true
console.log(typeof Object, typeof Date, typeof String, typeof Object === 'function')
