#include "gea_runtime.h"
#include <cassert>
#include <iostream>
using gea::Value;
using Args=gea::Ref<gea::ArrayObject<Value>>;
auto key(const char* s){return gea::PropertyKey::string(s);}
Value num(double n){return Value::box(Value::Tag::Number,n);}
Value flag(bool b){return Value::box(Value::Tag::Boolean,b);}
int calls=0, mode=0;
Value expectedReceiver;
std::string trace;
Value callback(){return Value::boxMethod<1>(gea::CallableObject<Value(Value,Args)>(+[](void*,Value self,Args a)->Value{
  ++calls;
  assert(a->size()==3);
  if(expectedReceiver.tag()!=Value::Tag::Undefined) assert(Value::strictEquals(a->readElement(2),expectedReceiver));
  if(mode==5){trace+=std::to_string(static_cast<int>(a->readElement(1).as<double>()))+":"+std::to_string(static_cast<int>(a->readElement(0).as<double>()))+",";return flag(a->readElement(0).as<double>()>5);}
  if(mode==1){assert(self.as<double>()==42);assert(a->readElement(0).as<double>()==7);assert(a->readElement(1).as<double>()==1);return flag(true);}
  if(mode==2){auto r=a->readElement(2);if(calls==1){r.deleteProperty(key("1"));r.setProperty(key("2"),num(99));r.setProperty(key("length"),num(3));}return flag(false);}
  if(mode==3) throw num(91);
  if(mode==4) return Value::box(Value::Tag::String,std::string("truthy"));
  return flag(false);
},nullptr));}
template<class F>void typeError(F f){bool yes=false;try{f();}catch(const Value&e){yes=e.getProperty(key("name")).as<std::string>()=="TypeError";}assert(yes);}
int main(){
 auto array=gea::makeRef<gea::ArrayObject<Value>>();array->pushHole();array->push(num(7));
 Value receiver=Value::box(Value::Tag::Object,array);
 Value some=receiver.getProperty(key("some"));
 assert(some.tag()==Value::Tag::Function);
 assert(gea::dynamicArrayPrototypeHas(key("some")));
 auto proto=Value::box(Value::Tag::Object,gea::arrayPrototypeObject());
 assert(proto.getProperty(key("some")).tag()==Value::Tag::Function);
 // Reading the intrinsic and the array method must preserve the same callable.
 assert(Value::strictEquals(some,proto.getProperty(key("some"))));
 expectedReceiver=receiver;mode=1;calls=0;assert(some.callWithReceiver(receiver,{callback(),num(42)}).as<bool>());assert(calls==1);
 mode=0;calls=0;assert(!some.callWithReceiver(receiver,{callback()}).as<bool>());assert(calls==1);
 auto empty=Value::box(Value::Tag::Object,gea::makeRef<gea::ArrayObject<Value>>());
 typeError([&]{some.callWithReceiver(empty,{num(1)});});
 typeError([&]{some.callWithReceiver(Value(),{callback()});});
 typeError([&]{some.callWithReceiver(Value::box(Value::Tag::Null,nullptr),{callback()});});
 for(const Value primitive:{num(1),flag(false),Value::box(Value::Tag::String,std::string("abc"))}){
   bool refused=false;try{some.callWithReceiver(primitive,{callback()});}catch(const Value& error){
     refused=error.getProperty(key("name")).as<std::string>()=="TypeError"&&error.getProperty(key("message")).as<std::string>()=="Native Array.prototype.some does not support primitive wrappers";
   }assert(refused);
 }
 Value generic=Value::object();generic.setProperty(key("length"),num(2));generic.setProperty(key("0"),num(1));generic.setProperty(key("1"),num(2));
 expectedReceiver=generic;mode=2;calls=0;assert(!some.callWithReceiver(generic,{callback()}).as<bool>());assert(calls==1);
 auto inherited=Value::object();inherited.setProperty(key("1"),num(7));
 Value child=Value::object();child.asDynamicObject()->setPrototype(inherited.asDynamicObject());child.setProperty(key("length"),num(2.9));
 expectedReceiver=child;mode=1;calls=0;assert(some.callWithReceiver(child,{callback(),num(42)}).as<bool>());assert(calls==1);
 expectedReceiver=receiver;mode=3;calls=0;bool thrown=false;try{some.callWithReceiver(receiver,{callback()});}catch(const Value&e){thrown=e.as<double>()==91;}assert(thrown&&calls==1);
 mode=4;calls=0;assert(some.callWithReceiver(receiver,{callback()}).as<bool>()&&calls==1);
 for(double length:{-1.0,0.0,std::numeric_limits<double>::quiet_NaN()}){child.setProperty(key("length"),num(length));calls=0;assert(!some.callWithReceiver(child,{callback()}).as<bool>()&&calls==0);}
 Value observed=Value::object();int lengthReads=0;
 gea::PropertyDescriptor lengthDescriptor;lengthDescriptor.hasGet=true;lengthDescriptor.get=[&](const Value&){++lengthReads;return num(std::numeric_limits<double>::infinity());};
 assert(observed.defineProperty(key("length"),lengthDescriptor));observed.setProperty(key("0"),num(1));
 expectedReceiver=observed;mode=4;calls=0;assert(some.callWithReceiver(observed,{callback()}).as<bool>());assert(calls==1&&lengthReads==1);
 Value emptyGeneric=Value::object();emptyGeneric.setProperty(key("length"),num(0));
 typeError([&]{some.callWithReceiver(emptyGeneric,{});});
 // A throwing later getter is never touched after a truthy first result.
 gea::PropertyDescriptor later;later.hasGet=true;later.get=[](const Value&)->Value{throw num(99);};
 Value early=Value::object();early.setProperty(key("length"),num(2));early.setProperty(key("0"),num(1));assert(early.defineProperty(key("1"),later));
 expectedReceiver=early;mode=4;calls=0;assert(some.callWithReceiver(early,{callback()}).as<bool>()&&calls==1);
 auto defaultPrototype=gea::arrayPrototypeObject();
 assert(defaultPrototype->size()==0);defaultPrototype->pushHole();defaultPrototype->push(num(7));
 auto inheritedArray=gea::makeRef<gea::ArrayObject<Value>>();inheritedArray->pushHole();inheritedArray->pushHole();
 Value inheritedReceiver=Value::box(Value::Tag::Object,inheritedArray);
 assert(inheritedReceiver.hasProperty(key("1")));assert(inheritedReceiver.getProperty(key("1")).as<double>()==7);
 expectedReceiver=inheritedReceiver;mode=1;calls=0;assert(some.callWithReceiver(inheritedReceiver,{callback(),num(42)}).as<bool>()&&calls==1);
 int inheritedReads=0;gea::PropertyDescriptor inheritedGetter;inheritedGetter.hasGet=true;
 inheritedGetter.get=[&](const Value& self){++inheritedReads;assert(Value::strictEquals(self,inheritedReceiver));return num(7);};
 assert(proto.defineProperty(key("1"),inheritedGetter));
 assert(inheritedReceiver.hasProperty(key("1"))&&inheritedReads==0);
 assert(inheritedReceiver.getProperty(key("1")).as<double>()==7&&inheritedReads==1);
 assert(inheritedReceiver.defineProperty(key("1"),gea::PropertyDescriptor::assignment(Value())));
 assert(inheritedReceiver.hasProperty(key("1"))&&inheritedReceiver.getProperty(key("1")).tag()==Value::Tag::Undefined&&inheritedReads==1);
 assert(proto.deleteProperty(key("1")));assert(inheritedReceiver.deleteProperty(key("1")));
 assert(!inheritedReceiver.hasProperty(key("1"))&&inheritedReceiver.getProperty(key("1")).tag()==Value::Tag::Undefined);
 defaultPrototype->setLength(0);
 expectedReceiver=receiver;mode=1;calls=0;
 Value callableProxy=Value::proxy(callback(),Value::object());
 assert(some.callWithReceiver(receiver,{callableProxy,num(42)}).as<bool>()&&calls==1);
 callableProxy.revokeProxy();
 assert(!some.callWithReceiver(empty,{callableProxy}).as<bool>());
 typeError([&]{some.callWithReceiver(receiver,{callableProxy});});
 Value applyHandler=Value::object();
 applyHandler.setProperty(key("apply"),Value::box(Value::Tag::Function,gea::CallableObject<Value(Value,Value,Value)>(+[](void*,Value target,Value self,Value args){
   assert(target.tag()==Value::Tag::Function);assert(self.as<double>()==42);
   assert(args.getProperty(key("0")).as<double>()==7);assert(args.getProperty(key("1")).as<double>()==1);
   return flag(true);
 },nullptr)));
 assert(some.callWithReceiver(receiver,{Value::proxy(callback(),applyHandler),num(42)}).as<bool>());
 int nested=0;
 Value reentrant=Value::boxMethod<1>(gea::CallableObject<Value(Value,Args)>(+[](void* env,Value,Args a)->Value{
   auto& count=*static_cast<int*>(env);++count;
   auto method=gea::dynamicArrayPrototypeGet(key("some"));
   Value inner=Value::boxMethod<1>(gea::CallableObject<Value(Value,Args)>(+[](void*,Value,Args){return flag(true);},nullptr));
   return method.callWithReceiver(a->readElement(2),{inner});
 },&nested));
 assert(some.callWithReceiver(receiver,{reentrant}).as<bool>()&&nested==1);
 Value traced=Value::object();traced.asDynamicObject()->setPrototype(inherited.asDynamicObject());traced.setProperty(key("length"),num(4));traced.setProperty(key("0"),num(1));traced.setProperty(key("2"),num(9));
 expectedReceiver=traced;mode=5;calls=0;const bool answer=some.callWithReceiver(traced,{callback()}).as<bool>();
 std::cout<<trace<<";"<<(answer?"true":"false")<<";"<<calls<<"\n";
}
