const fs = require('node:fs')
if (!fs.existsSync('dist/REPORT.txt')) { console.error('FAIL: dist/REPORT.txt 없음'); process.exit(1) }
console.log('PASS')
