//! expect: 2 Clean false true
// A record whose field is a shared array of nullable records held BY VALUE
// (`Ref<ArrayObject<Optional<Entry>>>`) asks, in its own trace signature,
// whether the array's elements trace -- which instantiates `Optional<Entry>`
// and so needs `Entry` complete. Nothing else about the field needs `Entry`,
// so the holder used to be emitted first whenever its structural number sorted
// before the entry's. The 64 distinct padding records push the holder's number
// across the `99`/`100` lexical boundary; with one fewer, the order came out
// right by accident.
class Observer {
  library(names: string[]) {
    const entries: ({ name: string; synth: boolean } | null)[] = []
    for (const name of names) entries.push(name ? { name, synth: false } : null)
    return entries
  }
  state(names: string[]) {
    return {
      library: this.library(names),
      padding: {
        p1: { v1: 1 },
        p2: { v2: 2 },
        p3: { v3: 3 },
        p4: { v4: 4 },
        p5: { v5: 5 },
        p6: { v6: 6 },
        p7: { v7: 7 },
        p8: { v8: 8 },
        p9: { v9: 9 },
        p10: { v10: 10 },
        p11: { v11: 11 },
        p12: { v12: 12 },
        p13: { v13: 13 },
        p14: { v14: 14 },
        p15: { v15: 15 },
        p16: { v16: 16 },
        p17: { v17: 17 },
        p18: { v18: 18 },
        p19: { v19: 19 },
        p20: { v20: 20 },
        p21: { v21: 21 },
        p22: { v22: 22 },
        p23: { v23: 23 },
        p24: { v24: 24 },
        p25: { v25: 25 },
        p26: { v26: 26 },
        p27: { v27: 27 },
        p28: { v28: 28 },
        p29: { v29: 29 },
        p30: { v30: 30 },
        p31: { v31: 31 },
        p32: { v32: 32 },
        p33: { v33: 33 },
        p34: { v34: 34 },
        p35: { v35: 35 },
        p36: { v36: 36 },
        p37: { v37: 37 },
        p38: { v38: 38 },
        p39: { v39: 39 },
        p40: { v40: 40 },
        p41: { v41: 41 },
        p42: { v42: 42 },
        p43: { v43: 43 },
        p44: { v44: 44 },
        p45: { v45: 45 },
        p46: { v46: 46 },
        p47: { v47: 47 },
        p48: { v48: 48 },
        p49: { v49: 49 },
        p50: { v50: 50 },
        p51: { v51: 51 },
        p52: { v52: 52 },
        p53: { v53: 53 },
        p54: { v54: 54 },
        p55: { v55: 55 },
        p56: { v56: 56 },
        p57: { v57: 57 },
        p58: { v58: 58 },
        p59: { v59: 59 },
        p60: { v60: 60 },
        p61: { v61: 61 },
        p62: { v62: 62 },
        p63: { v63: 63 },
        p64: { v64: 64 }
      }
    }
  }
}
const state = new Observer().state(['Clean', ''])
const first = state.library[0]
console.log(state.library.length, first ? first.name : '-', first ? first.synth : '-', state.library[1] === null)
