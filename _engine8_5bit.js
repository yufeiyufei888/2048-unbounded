/*
 * _engine8_5bit.js —— 5-bit/格编码引擎骨架（第Ⅵ轮 B 线：突破 32768 编码上限）
 * ==========================================================================
 * 布局：4 行 × uint32（每格 5bit，行内 20bit 有效，高位补零）
 *   指数 0..20：0=空，k=2^k（2^20 = 1,048,576 > 数学极限 131072×8，编码富余）
 * 行 LUT：1<<20 = 1,048,576 项
 *   SLIDE_L/SLIDE_R（Uint32Array 4MB×2）行滑动结果
 *   SCORE_LUT（Float32Array 4MB）行得分
 *   SNAKE_LUT（Float64Array 8MB）蛇形行表（单表版，行列共用——nneonneo 形状）
 * 转置：逐格 5bit 抽取组装（正确性优先，性能后优化）
 * 验证：≤32768 的随机盘面与 _engine7_prob.js 的 moveDir/evaluate 语义一致性
 */
'use strict';

const ROW_LEN = 1 << 20;                       // 2^20
const MASK20 = (1 << 20) >>> 0;

const SLIDE_L = new Uint32Array(ROW_LEN);
const SLIDE_R = new Uint32Array(ROW_LEN);
const SCORE_LUT = new Float64Array(ROW_LEN);
const SNAKE_LUT = new Float64Array(ROW_LEN);   // 单表：行 4 次 + 转置 4 次
const MONO_LUT = new Float64Array(ROW_LEN);
const EMPTY_LUT = new Uint8Array(ROW_LEN);

const POW5 = new Float64Array(25);
for (let i = 0; i < 25; i++) POW5[i] = Math.pow(2, i);

// 蛇形位置（列字转置后的蛇形位置沿用 4-bit 的 SNAKE_POS——转置行的 4 格对应棋盘列）
const SNAKE_POS = new Int32Array([
  0,  1,  2,  3,
  7,  6,  5,  4,
  8,  9, 10, 11,
 15, 14, 13, 12
]);

let tablesBuilt = false;
function buildTables(snakeBase) {
  if (tablesBuilt) return;
  const SW = new Float64Array(25);
  for (let k = 0; k < 25; k++) SW[k] = Math.pow(snakeBase, 15 - k);
  for (let row = 0; row < ROW_LEN; row++) {
    // 4 格 5bit：c0 高位（bit15-19）… c3 低位（bit0-4）
    const c0 = (row >>> 15) & 0x1F, c1 = (row >>> 10) & 0x1F, c2 = (row >>> 5) & 0x1F, c3 = row & 0x1F;
    const cs = [c0, c1, c2, c3];
    // 左滑
    const t = [];
    for (let c = 0; c < 4; c++) if (cs[c]) t.push(cs[c]);
    const out = [];
    let g = 0;
    for (let i = 0; i < t.length; i++) {
      if (i + 1 < t.length && t[i] === t[i + 1]) { const nv = Math.min(t[i] + 1, 24); out.push(nv); g += POW5[nv]; i++; }
      else out.push(t[i]);
    }
    while (out.length < 4) out.push(0);
    const nl = (out[0] << 15) | (out[1] << 10) | (out[2] << 5) | out[3];
    SLIDE_L[row] = nl >>> 0;
    SCORE_LUT[row] = g;
    // 右滑 = reverse(slide(reverse))
    const rv = (r) => ((r & 0x1F) << 15) | ((r & 0x3E0) << 5 >> 5) | (((r >>> 10) & 0x1F) << 10 >>> 10) | (((r >>> 15) & 0x1F) >>> 0) | 0;
    // 直接显式 reverse（5bit 版）
    const rev = ((row & 0x1F) << 15) | (((row >>> 5) & 0x1F) << 10) | (((row >>> 10) & 0x1F) << 5) | ((row >>> 15) & 0x1F);
    SLIDE_R[row] = SLIDE_L[rev] === undefined ? 0 : (function () {
      // 对 rev 做左滑再 reverse——但 SLIDE_L[rev] 尚未填充（正在构建）……改为直接计算右滑
      const cs2 = [c3, c2, c1, c0];
      const t2 = [];
      for (let c = 0; c < 4; c++) if (cs2[c]) t2.push(cs2[c]);
      const out2 = [];
      for (let i = 0; i < t2.length; i++) {
        if (i + 1 < t2.length && t2[i] === t2[i + 1]) { const nv = Math.min(t2[i] + 1, 24); out2.push(nv); i++; }
        else out2.push(t2[i]);
      }
      while (out2.length < 4) out2.push(0);
      // out2 是从右往左的序列，反转回
      const r3v = out2[0], r2v = out2[1], r1v = out2[2], r0v = out2[3];
      return ((r0v << 15) | (r1v << 10) | (r2v << 5) | r3v) >>> 0;
    })();
    // 特征
    let mono = 0;
    for (let c = 0; c < 3; c++) { const a = POW5[cs[c]], b = POW5[cs[c + 1]]; if (a && b) mono += Math.abs(a - b); }
    let sn = 0;
    for (let c = 0; c < 4; c++) if (cs[c] > 0) sn += POW5[cs[c]] * SW[SNAKE_POS[c]];
    EMPTY_LUT[row] = (cs[0] ? 0 : 1) + (cs[1] ? 0 : 1) + (cs[2] ? 0 : 1) + (cs[3] ? 0 : 1);
    SNAKE_LUT[row] = sn;
    MONO_LUT[row] = mono;
  }
  tablesBuilt = true;
}

// 转置：r0..r3（各 4 格 5bit）→ c0..c3（转置后的行字）
function transpose(r0, r1, r2, r3) {
  function gx(r, c) { return (r >>> (15 - 5 * c)) & 0x1F; }
  const mk = (a, b, c, d) => ((a << 15) | (b << 10) | (c << 5) | d) >>> 0;
  return [
    mk(gx(r0, 0), gx(r1, 0), gx(r2, 0), gx(r3, 0)),
    mk(gx(r0, 1), gx(r1, 1), gx(r2, 1), gx(r3, 1)),
    mk(gx(r0, 2), gx(r1, 2), gx(r2, 2), gx(r3, 2)),
    mk(gx(r0, 3), gx(r1, 3), gx(r2, 3), gx(r3, 3))
  ];
}

function moveDir(r0, r1, r2, r3, dir) {
  const src = dir === 2 || dir === 3 ? transpose(r0, r1, r2, r3) : [r0, r1, r2, r3];
  const f = dir === 1 || dir === 3 ? SLIDE_R : SLIDE_L;
  const out = [];
  let gained = 0, moved = false;
  for (let i = 0; i < 4; i++) {
    const nl = f[src[i]];
    if ((nl >>> 0) !== (src[i] >>> 0)) moved = true;
    gained += SCORE_LUT[src[i]];
    out.push(nl >>> 0);
  }
  const fin = dir === 2 || dir === 3 ? transpose(out[0], out[1], out[2], out[3]) : out;
  return { rows: fin, gained, moved };
}

function hasMove(r0, r1, r2, r3) {
  for (let d = 0; d < 4; d++) if (moveDir(r0, r1, r2, r3, d).moved) return true;
  return false;
}

module.exports = { buildTables, transpose, moveDir, hasMove, ROW_LEN, SNAKE_LUT, MONO_LUT, EMPTY_LUT, SCORE_LUT, SLIDE_L, SLIDE_R };
