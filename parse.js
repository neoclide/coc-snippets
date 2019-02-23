let str = '${1/\\w+//g} ${VISUAL:abc/\\w+\\/\\w//g}'

let res = str
.replace(/((?:[^\\]?\$\{(?:\d+|VISUAL(?:[^/]*)))\/)(.*?[^\\])(?=\/)/g, function (match, p1, p2) {
  return p1 + p2
})

console.log(res)
