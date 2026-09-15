// v7 长跑 + 进度落盘（可随时查看）
const E = require('./_e7fix.js');
const fs = require('fs');
const N = parseInt(process.env.N || '600', 10);
const OUT = '_v7progress.json';
const arr = [];
const START = Date.now();
function dump(finished) {
  const sorted = arr.slice().sort((a, b) => b - a);
  fs.writeFileSync(OUT, JSON.stringify({
    engine: 'v7 (指数蛇形权重 + 极速内核)',
    depth: 5, limit: 6, budget: 45000,
    games: arr.length, target: N,
    avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    median: sorted[Math.floor(sorted.length / 2)] || 0,
    best: sorted[0] || 0,
    top10: sorted.slice(0, 10),
    elapsedSec: (Date.now() - START) / 1000,
    finished: !!finished,
    perGame: arr
  }, null, 1));
}
for (let g = 1; g <= N; g++) {
  const r = E.playGame(5, 6, 45000);
  const prevBest = arr.length ? Math.max(...arr) : 0;
  arr.push(r.score);
  if (g % 5 === 0 || r.score > prevBest) dump(false);
  if (g % 10 === 0) {
    const sorted = arr.slice().sort((a, b) => b - a);
    console.log(`${g}/${N} | 均分 ${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(0)} | 最高 ${sorted[0]} | ${((Date.now() - START) / 1000).toFixed(0)}s`);
  }
  if (r.score > prevBest) console.log(`  [新纪录] 第 ${g} 局 | ${r.score} | 最大块 ${Math.pow(2, r.maxExp)} | ${r.steps} 步`);
}
dump(true);
const sorted = arr.slice().sort((a, b) => b - a);
console.log(`\n===== v7 长跑完成 =====`);
console.log(`局数 ${N} | 均分 ${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(0)} | 中位 ${sorted[Math.floor(sorted.length / 2)]} | 最高 ${sorted[0]}`);
console.log(`前10: ${sorted.slice(0, 10).join(', ')}`);
