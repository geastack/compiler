export {}

const endEmpty = /(?:)/g
const stickySearch = /b/y
stickySearch.lastIndex = 1

const stickyReplace = /b/y
stickyReplace.lastIndex = 1

const globalStickyReplace = /b/gy
globalStickyReplace.lastIndex = 1

const advancingStickyReplace = /a|c/gy

console.log(
  `${''.replace(endEmpty, '-')}|${'ab'.search(stickySearch)}|${stickySearch.lastIndex}|${'ab'.replace(
    stickyReplace,
    'X'
  )}|${stickyReplace.lastIndex}|${'ab'.replace(globalStickyReplace, 'X')}|${
    globalStickyReplace.lastIndex
  }|${'abc'.replace(advancingStickyReplace, 'X')}|${advancingStickyReplace.lastIndex}`
)

//! expect: -|-1|1|aX|2|ab|0|Xbc|0
