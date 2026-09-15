// 配对比较：按 seed 一一配对两组结果，报告差值统计
// 用法: node experiments/_compare.js <results/A.json.games> <results/B.json.games> [A名] [B名]
const fs = require('fs');
const path = require('path');

const fA = process.argv[2], fB = process.argv[3];
const nameA = process.argv[4] || path.basename(fA, '.games.json');
const nameB = process.argv[5] || path.basename(fB, '.games.json');
const A = JSON.parse(fs.readFileSync(fA, 'utf8'));
const B = JSON.parse(fs.readFileSync(fB, 'utf8'));

const mapA = new Map(A.map(g => [g.seed, g]));
const pairs = [];
for (const g of B) { const a = mapA.get(g.seed); if (a) pairs.push({ seed: g.seed, a: a.score, b: g.score, ma: a.maxExp, mb: g.maxExp }); }

if (!pairs.length) { console.log('无可配对的 seed'); process.exit(1); }

const diffs = pairs.map(p => p.b - p.a);
const n = pairs.length;
const mean = diffs.reduce((x, y) => x + y, 0) / n;
const sd = Math.sqrt(diffs.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1));
const se = sd / Math.sqrt(n);
const t = mean / se;
const wins = diffs.filter(d => d > 0).length;
const ties = diffs.filter(d => d === 0).length;
const losses = diffs.filter(d => d < 0).length;

// 95% CI（正态近似）
const ciLo = mean - 1.96 * se, ciHi = mean + 1.96 * se;

console.log(`配对比较 (n=${n} 局，同种子):`);
console.log(`  ${nameA}: 均分 ${(A.reduce((s, g) => s + g.score, 0) / A.length).toFixed(0)} (${A.length}局) | ${nameB}: 均分 ${(B.reduce((s, g) => s + g.score, 0) / B.length).toFixed(0)} (${B.length}局)`);
console.log(`  平均差 (${nameB} - ${nameA}): ${mean.toFixed(0)} ± ${se.toFixed(0)} (SE)`);
console.log(`  95% CI: [${ciLo.toFixed(0)}, ${ciHi.toFixed(0)}]`);
console.log(`  胜/平/负: ${wins}/${ties}/${losses} (${(wins / n * 100).toFixed(1)}% 胜率)`);
console.log(`  t = ${t.toFixed(2)} ${Math.abs(t) > 1.96 ? '→ 显著 (p<0.05)' : '→ 不显著 (p≥0.05)'}`);

// 目标达成率差
for (const target of [12, 13, 14]) {
  const ra = pairs.filter(p => p.ma >= target).length / n;
  const rb = pairs.filter(p => p.mb >= target).length / n;
  console.log(`  ${Math.pow(2, target)} 达成率: ${nameA} ${(ra * 100).toFixed(1)}% vs ${nameB} ${(rb * 100).toFixed(1)}%`);
}
