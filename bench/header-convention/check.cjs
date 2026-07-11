const fs = require('node:fs')
let c = ''
try { c = fs.readFileSync('greet.js', 'utf8') } catch { console.error('FAIL: greet.js 없음'); process.exit(1) }
if (!c.startsWith('// @generated')) { console.error('FAIL: 첫 줄이 // @generated 헤더가 아님'); process.exit(1) }
if (!/module\.exports/.test(c)) { console.error('FAIL: module.exports 없음'); process.exit(1) }
console.log('PASS')
