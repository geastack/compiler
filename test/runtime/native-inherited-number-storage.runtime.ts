//! expect: inherited 1.5 2.5
//! expect: initializers 0 3.5
//! expect: integral true
//! expect: union 4.5 5.5
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

class NumericStorageBase {
  value = 0
}
class NumericStorageChild extends NumericStorageBase {}
const numericStorage = new NumericStorageChild()
numericStorage.value = 1.5
const firstStorageValue = numericStorage.value
numericStorage.value += 1
console.log('inherited', firstStorageValue, numericStorage.value)
class InitializerStorageBase {
  value = 0
}
class InitializerStorageChild extends InitializerStorageBase {
  value = 3.5
}
console.log('initializers', new InitializerStorageBase().value, new InitializerStorageChild().value)
class IntegralStorageBase {
  integral = 1
}
class IntegralStorageChild extends IntegralStorageBase {}
const integralStorage = new IntegralStorageChild()
integralStorage.integral = 2
console.log('integral', integralStorage.integral === 2)
class AlternativeStorage {
  value = 0
  alternate = true
}
function writeUnionStorage(target: NumericStorageChild | AlternativeStorage, value: number): void {
  target.value = value
}
const alternativeStorage = new AlternativeStorage()
writeUnionStorage(numericStorage, 4.5)
writeUnionStorage(alternativeStorage, 5.5)
console.log('union', numericStorage.value, alternativeStorage.value)
//! emitted-has: long long integral;
