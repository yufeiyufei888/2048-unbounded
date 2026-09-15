// 引擎变体生成器：从 _engine7.js 生成可 require 的实验版本
// 用法: node _mk.js <输出名> "<from>|<to>" ["<from>|<to>" ...]
// 空格用 @ 代替（bash 友好）
const fs = require('fs');

const out = process.argv[2];
const patches = process.argv.slice(3).map(s => {
  const i = s.indexOf('|');
  return { from: s.slice(0, i).replace(/@/g, ' '), to: s.slice(i + 1).replace(/@/g, ' ') };
});

let src = fs.readFileSync('_engine7.js', 'utf8');

for (const p of patches) {
  if (!src.includes(p.from)) { console.error('未找到替换目标:', JSON.stringify(p.from)); process.exit(1); }
  src = src.split(p.from).join(p.to);
}

const marker = 'if (require.main === module) {';
const idx = src.lastIndexOf(marker);
if (idx >= 0) src = src.slice(0, idx) + 'if (false) {\n' + src.slice(idx + marker.length);

fs.writeFileSync(out, src);
console.log('已生成', out, '| 补丁数', patches.length);
