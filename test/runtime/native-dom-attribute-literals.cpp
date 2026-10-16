#include "gea_runtime.h"
#include <cassert>
#include <cstdio>
#include <string>
// Unit seam is the public native node setter contract; the actual emitted
// Studio fixture separately exercises real NodeHandle/Tree storage.
struct AttributeNode {
 mutable std::string name,value;
 void setAttribute(const std::string&n,const std::string&v)const{name=n;value=v;}
};
int main(){AttributeNode n;using gea::runtime::host::domSetAttribute;
 domSetAttribute(n,"id","native-space-workspace");assert(n.name=="id"&&n.value=="native-space-workspace");
 const char*borrowed="borrowed";domSetAttribute(n,"data-value",borrowed);assert(n.value=="borrowed");
 domSetAttribute(n,"data-value","");assert(n.value.empty());
 domSetAttribute(n,"data-value","false");assert(n.value=="false");
 domSetAttribute(n,"data-value","0");assert(n.value=="0");
 domSetAttribute(n,"data-value","Grüße");assert(n.value=="Grüße");
 domSetAttribute(n,"data-value",std::string("owned"));assert(n.value=="owned");
 domSetAttribute(n,"data-value",false);assert(n.value=="false");
 domSetAttribute(n,"data-value",true);assert(n.value=="true");
 domSetAttribute(n,"data-value",1.25);assert(n.value=="1.25");
 bool refused=false;try{domSetAttribute(n,"data-value",static_cast<const char*>(nullptr));}catch(const std::invalid_argument&){refused=true;}assert(refused);
 puts("PASS actual runtime native attribute string literal/pointer/owned/empty/UTF8 plus unchanged bool/number delegation; no GUI or Core");}
