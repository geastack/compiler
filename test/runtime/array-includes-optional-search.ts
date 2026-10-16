// Actual Studio workspace optional-status includes refusal reduced to the
// comparison authority. Type assertions do not coerce or unwrap at runtime.
const modes:string[]=['start','stop','']
function stringSearch(value?:string,from=0):boolean{return modes.includes(value as string,from)}
//! expect: optional-search=false,true,true,false,true
console.log('optional-search='+stringSearch()+','+stringSearch('stop')+','+stringSearch('')+','+stringSearch('missing')+','+stringSearch('stop',-2))
//! expect: optional-from=false,false,true,true,false
console.log('optional-from='+stringSearch('stop',2)+','+stringSearch('stop',Infinity)+','+stringSearch('stop',NaN)+','+stringSearch('stop',-Infinity)+','+stringSearch('start',1.9))
const numbers:number[]=[NaN,-0,3]
function numberSearch(value?:number,from=0):boolean{return numbers.includes(value as number,from)}
//! expect: optional-number=false,true,true,true,false
console.log('optional-number='+numberSearch()+','+numberSearch(NaN)+','+numberSearch(0)+','+numberSearch(-0)+','+numberSearch(0,2))
const flags:boolean[]=[false,true]
function boolSearch(value?:boolean):boolean{return flags.includes(value as boolean)}
//! expect: optional-boolean=false,true,true
console.log('optional-boolean='+boolSearch()+','+boolSearch(false)+','+boolSearch(true))
const sparse:string[]=[]
sparse.length=2
sparse[1]='live'
function sparseSearch(value?:string,from=0):boolean{return sparse.includes(value as string,from)}
//! expect: optional-hole=true,false,true,false
console.log('optional-hole='+sparseSearch()+','+sparseSearch(undefined,1)+','+sparseSearch('live')+','+sparseSearch('absent'))
const current={job:{status:'fixture-idle'}}
//! expect: actual-status=false
console.log('actual-status='+['preparingAttachment','cancellingAttachment'].includes(current?.job?.status))
