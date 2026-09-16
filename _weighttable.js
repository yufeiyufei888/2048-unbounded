/*
 * _weighttable.js —— 查表权重评价（第Ⅵ轮：sep-CMA-ES 进化的载体）
 * ==========================================================================
 * 设计：把 _engine7_prob.js 的手工评价（v7.4 参数化公式）逐项展开为 5 张表：
 *   R0..R3[65536]：行 0..3 各一张（蛇形主项按行位置不同 + 行级特征）
 *   T[65536]     ：列共享表（转置后行查 4 次 = 列特征）
 *   评价 = R0[r0]+R1[r1]+R2[r2]+R3[r3] + T[c0]+T[c1]+T[c2]+T[c3] + dEmpty 修正
 * dEmpty（全盘空格驱动）保留为固定修正项（不进化，保持 v7.4 值），deepOnMaxExp 留在搜索层。
 *
 * 关键纪律：展开 = 逐项照抄 evaluate 表达式（不做语义判断，符号自动正确），
 *           展开后必须通过「10 万随机盘逐位一致」验证才能用于进化。
 */
'use strict';

const PROB = require('./_engine7_prob.js');

// SNAKE_POS 直接从 prob 引擎源码复制（0,1,2,3 / 7,6,5,4 / 8,9,10,11 / 15,14,13,12）
const POW2 = new Float64Array(20);
for (let i = 0; i < 20; i++) POW2[i] = Math.pow(2, i);

// 蛇形位置权重（与 prob 引擎 SNAKE_POS 一致）
const SNAKE_POS = new Int32Array([
  0,  1,  2,  3,
  7,  6,  5,  4,
  8,  9, 10, 11,
 15, 14, 13, 12
]);

function buildInitialTables(p) {
  // p：v7.4 参数 {base, wMono, wSmooth, wEmpty, dEmpty1, dEmpty2, ...}
  const base = p.base, wMono = p.wMono, wSmooth = p.wSmooth, wEmpty = p.wEmpty;
  const SW = new Float64Array(16);
  for (let k = 0; k < 16; k++) SW[k] = Math.pow(base, 15 - k);
  const R = [];
  for (let r = 0; r < 4; r++) {
    const tab = new Float64Array(65536);
    R.push(tab);
  }
  const T = new Float64Array(65536);
  for (let row = 0; row < 65536; row++) {
    const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
    const cs = [c0, c1, c2, c3];
    let emp = 0, smooth = 0, inc = 0, dec = 0;
    for (let c = 0; c < 4; c++) if (cs[c] === 0) emp++;
    for (let c = 0; c < 3; c++) {
      const a = cs[c], b = cs[c + 1];
      if (a && b) { const d = Math.abs(POW2[a] - POW2[b]); smooth += d; if (b > a) dec += d; else inc += d; }
    }
    const monoMax = inc > dec ? inc : dec;
    // 行表：蛇形主项（按行位置）+ 行级特征
    for (let r = 0; r < 4; r++) {
      let sq = 0;
      for (let c = 0; c < 4; c++) {
        const e = cs[c];
        if (e === 0) continue;
        sq += POW2[e] * SW[SNAKE_POS[r * 4 + c]];
      }
      R[r][row] = sq + monoMax * wMono - smooth * wSmooth + emp * wEmpty;
    }
    // 列表：列级特征（无蛇形位置差异，无 empty——空格是全盘标量，只在行表计一次）
    T[row] = monoMax * wMono - smooth * wSmooth;
  }
  return { R, T };
}

module.exports = { buildInitialTables, SNAKE_POS, POW2 };
