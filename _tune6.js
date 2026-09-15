/*
 * v6 参数自动调参（分组扫描 + 局部精修）
 */
'use strict';
const E = require('./_engine6.js');

const GAMES = 4, DEPTH = 5, LIMIT = 6, BUDGET = 45000;

function trial(p) {
  E.setParams(p);
  let sum = 0, mx = 0, mxe = 0, steps = 0;
  for (let g = 0; g < GAMES; g++) {
    const r = E.playGame(DEPTH, LIMIT, BUDGET);
    sum += r.score; steps += r.steps; if (r.score > mx) mx = r.score; if (r.maxExp > mxe) mxe = r.maxExp;
  }
  return { avg: sum / GAMES, mx, mxe, steps: steps / GAMES };
}

// 基准
const BASE = E.getParams();
console.log('基准:', JSON.stringify(BASE));
const b = trial(BASE);
console.log(`基准 → 均分 ${b.avg.toFixed(0)} | 最高 ${b.mx} | 最大块 ${Math.pow(2,b.mxe)} | 均步 ${b.steps.toFixed(0)}`);

// 单参数扫描
const axes = {
  wSnake:    [40, 100, 220],
  wDisorder: [120, 260, 520],
  wEmpty:    [300, 700, 1400],
  wMono:     [15, 40, 100],
  wSmooth:   [25, 60, 140],
  wCorner:   [300, 900, 2000],
  bigBoost:  [100, 260, 600],
  dEmpty1:   [45000, 90000, 200000],
  dEmpty2:   [6000, 12000, 30000]
};

let bestP = Object.assign({}, BASE);
let bestAvg = b.avg;
const START = Date.now();

// 两轮坐标下降
for (let round = 0; round < 2; round++) {
  console.log(`\n===== 第 ${round+1} 轮坐标下降 =====`);
  for (const key of Object.keys(axes)) {
    let localBest = bestP[key], localAvg = bestAvg;
    for (const val of axes[key]) {
      if (val === bestP[key]) continue;
      const p = Object.assign({}, bestP, { [key]: val });
      const r = trial(p);
      const mark = r.avg > localAvg ? ' ⭐' : '';
      console.log(`  ${key}=${val} → 均分 ${r.avg.toFixed(0)} | 最高 ${r.mx} | 最大块 ${Math.pow(2,r.mxe)} | ${((Date.now()-START)/1000).toFixed(0)}s${mark}`);
      if (r.avg > localAvg) { localAvg = r.avg; localBest = val; }
    }
    if (localBest !== bestP[key]) {
      bestP[key] = localBest; bestAvg = localAvg;
      console.log(`  ✅ ${key} → ${localBest}（均分 ${bestAvg.toFixed(0)}）`);
    }
  }
}

// 用最优参数做一次较长验证
console.log('\n===== 最优参数 (验证 8 局) =====');
console.log(JSON.stringify(bestP));
E.setParams(bestP);
let sum = 0, mx = 0, mxe = 0;
const rows = [];
for (let g = 0; g < 8; g++) { const r = E.playGame(DEPTH, LIMIT, BUDGET); rows.push(r.score); sum += r.score; if (r.score > mx) mx = r.score; if (r.maxExp > mxe) mxe = r.maxExp; }
console.log(`8 局均分 ${(sum/8).toFixed(0)} | 最高 ${mx} | 最大块 ${Math.pow(2,mxe)}`);
console.log('各局:', rows.sort((a,b)=>b-a).join(', '));
console.log('\nBEST=' + JSON.stringify(bestP));
