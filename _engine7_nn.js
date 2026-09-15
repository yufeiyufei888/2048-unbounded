/*
 * 2048 引擎 v7.2nn —— ttfix + nneonneo 式有界尺度评价（外部研究移植实验）
 * ==========================================================================
 * 【假设】v7 的指数蛇形权重 SW[k]=4.5^(15-k) 使主项尺度达 ~1e15（2^maxExp×4.5^15），
 *   单个最大方块主导整个评估 → 高阶阶段 AI 过度保守，不敢临时破坏蛇形次序去
 *   完成 8192+8192→16384 的关键合并，可能正是 16384 达成率 0% 的原因之一。
 *
 * 【移植】nneonneo/2048-ai（C++，16384 达成率约 90%、32768 约 1/3）的评价结构：
 *   每行/列独立有界启发式（4bit rank 空间，量级 ≤ 数百万）：
 *     + nnEmptyW * empties^1.5            （270）
 *     + nnMergeW * merges                 （700，相邻同 rank 组计数）
 *     - nnSumW  * Σ rank^3.5              （11，抑制无谓堆积）
 *     - nnMonoW * min(monoL, monoR)       （47，rank^4 差值，取较优方向）
 *   评估 = Σ 4 行 + Σ 4 列（列用同一张行表）。
 *   所有项随 rank 多项式增长，不存在指数主导项。
 *
 * 搜索/TT/种子机制与 _engine7_ttfix.js 完全一致；差分测试 T12 核对本评价实现。
 */
'use strict';

const ENGINE_TAG = 'v7.2-nn';

const POW2 = new Float64Array(40);
for (let i = 0; i < 40; i++) POW2[i] = Math.pow(2, i);

let rng = Math.random;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function setSeed(seed) { rng = mulberry32(seed >>> 0); }
function clearSeed() { rng = Math.random; }

const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);
const MOVE_LUT  = new Uint16Array(ROW_LUT_SIZE);
const RIGHT_LUT = new Uint16Array(ROW_LUT_SIZE);
function slideRowLeft(row) {
  const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
  const t = []; if (c0) t.push(c0); if (c1) t.push(c1); if (c2) t.push(c2); if (c3) t.push(c3);
  const out = []; let gained = 0;
  for (let i = 0; i < t.length; i++) {
    if (i + 1 < t.length && t[i] === t[i + 1]) { const nv = t[i] + 1; out.push(nv); gained += POW2[nv]; i++; }
    else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return { row: (out[0] << 12) | (out[1] << 8) | (out[2] << 4) | out[3], gained };
}
function reverseRow(row) { return ((row & 0xF) << 12) | ((row & 0xF0) << 4) | ((row & 0xF00) >> 4) | ((row & 0xF000) >> 12); }
for (let r = 0; r < ROW_LUT_SIZE; r++) { const x = slideRowLeft(r); MOVE_LUT[r] = x.row; SCORE_LUT[r] = x.gained; }
for (let r = 0; r < ROW_LUT_SIZE; r++) { RIGHT_LUT[r] = reverseRow(MOVE_LUT[reverseRow(r)]); }

let P = {
  base: 4.5,
  wEmpty: 60000, wMono: 3.0, wSmooth: 6.0, dEmpty1: 400000, dEmpty2: 60000, // v7 参数保留（nn 模式不用）
  phaseExp: 12, wMobility: 0, wMerge: 0, wCorner: 0, wDeadEnd: 0,
  sampleMode: 0,
  // nneonneo 式评价权重
  evalMode: 'nn',
  nnEmptyW: 270, nnMergeW: 700, nnSumW: 11, nnMonoW: 47
};

// ---------- nneonneo 式每行启发表 ----------
const NN_HEUR = new Float64Array(ROW_LUT_SIZE);
function nnScoreRow(row) {
  const r0 = (row >> 12) & 0xF, r1 = (row >> 8) & 0xF, r2 = (row >> 4) & 0xF, r3 = row & 0xF;
  const cs = [r0, r1, r2, r3];
  let empties = 0, sum = 0, merges = 0;
  for (let i = 0; i < 4; i++) { const e = cs[i]; if (e === 0) empties++; else sum += Math.pow(e, 3.5); }
  // 相邻同 rank 合并组（nneonneo 风格的 runs 计数）
  let run = 1;
  for (let i = 1; i < 4; i++) {
    if (cs[i] !== 0 && cs[i] === cs[i - 1]) run++;
    else { if (run > 1) merges += 1 + (run - 1); run = 1; }
  }
  if (run > 1) merges += 1 + (run - 1);
  // 单调性：两个方向的 rank^4 差值，取较优（小）方向
  let monoL = 0, monoR = 0;
  for (let i = 1; i < 4; i++) {
    const a = cs[i - 1], b = cs[i];
    if (a > b) monoL += Math.pow(a, 4) - Math.pow(b, 4);
    else if (b > a) monoR += Math.pow(b, 4) - Math.pow(a, 4);
  }
  const mono = Math.min(monoL, monoR);
  return P.nnEmptyW * Math.pow(empties, 1.5) + P.nnMergeW * merges - P.nnSumW * sum - P.nnMonoW * mono;
}
function buildNNTables() {
  for (let row = 0; row < ROW_LUT_SIZE; row++) NN_HEUR[row] = nnScoreRow(row);
}
buildNNTables();
function setParams(np) { P = Object.assign({}, P, np); buildNNTables(); }

let B_LO = 0, B_HI = 0, G = 0;
function moveDir(dir) {
  let nlo = 0, nhi = 0, gained = 0, moved = false;
  if (dir === 0 || dir === 1) {
    for (let r = 0; r < 4; r++) {
      const row = r < 2 ? (B_LO >>> (16 * r)) & 0xFFFF : (B_HI >>> (16 * (r - 2))) & 0xFFFF;
      const nrow = dir === 0 ? MOVE_LUT[row] : RIGHT_LUT[row];
      if (nrow !== row) moved = true;
      gained += SCORE_LUT[row];
      if (r < 2) nlo |= nrow << (16 * r); else nhi |= nrow << (16 * (r - 2));
    }
  } else {
    for (let c = 0; c < 4; c++) {
      const sh = 12 - 4 * c;
      const col = (((B_LO >>> sh) & 0xF) << 12) | (((B_LO >>> (16 + sh)) & 0xF) << 8)
                | (((B_HI >>> sh) & 0xF) << 4)  | ((B_HI >>> (16 + sh)) & 0xF);
      const ncol = dir === 2 ? MOVE_LUT[col] : RIGHT_LUT[col];
      if (ncol !== col) moved = true;
      gained += SCORE_LUT[col];
      nlo |= ((ncol >>> 12) & 0xF) << sh;
      nlo |= ((ncol >>> 8) & 0xF) << (16 + sh);
      nhi |= ((ncol >>> 4) & 0xF) << sh;
      nhi |= (ncol & 0xF) << (16 + sh);
    }
  }
  B_LO = nlo >>> 0; B_HI = nhi >>> 0; G = gained;
  return moved;
}

const CELLS = new Int32Array(16);
function readCells(lo, hi) {
  for (let r = 0; r < 4; r++) {
    const row = r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
    CELLS[r*4] = (row >> 12) & 0xF; CELLS[r*4+1] = (row >> 8) & 0xF; CELLS[r*4+2] = (row >> 4) & 0xF; CELLS[r*4+3] = row & 0xF;
  }
  return CELLS;
}

// ---------- 评估：行表 + 转置列，全部有界 ----------
function evaluate(lo, hi) {
  const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
  let s = NN_HEUR[r0] + NN_HEUR[r1] + NN_HEUR[r2] + NN_HEUR[r3];
  // 列编码（与 v7 相同的 nibble 重排）
  const c0 = ((r0 & 0xF000)) | ((r1 & 0xF000) >>> 4) | ((r2 & 0xF000) >>> 8) | ((r3 & 0xF000) >>> 12);
  const c1 = ((r0 & 0x0F00) << 4) | (r1 & 0x0F00) | ((r2 & 0x0F00) >>> 4) | ((r3 & 0x0F00) >>> 8);
  const c2 = ((r0 & 0x00F0) << 8) | ((r1 & 0x00F0) << 4) | (r2 & 0x00F0) | ((r3 & 0x00F0) >>> 4);
  const c3 = ((r0 & 0x000F) << 12) | ((r1 & 0x000F) << 8) | ((r2 & 0x000F) << 4) | (r3 & 0x000F);
  s += NN_HEUR[c0] + NN_HEUR[c1] + NN_HEUR[c2] + NN_HEUR[c3];
  return s;
}

// ---------- 平坦类型数组 TT ----------
const TT_BITS = 21;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_KLO = new Uint32Array(TT_SIZE);
const TT_KHI = new Uint32Array(TT_SIZE);
const TT_TAG = new Uint8Array(TT_SIZE);
const TT_VAL = new Float64Array(TT_SIZE);
const TT_PROBE = 8;

function ttLookup(lo, hi, tag) {
  let idx = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77) ^ Math.imul(tag, 0xC2B2AE3D)) >>> 0 & TT_MASK;
  for (let p = 0; p < TT_PROBE; p++) {
    const t = TT_TAG[idx];
    if (t === 0) return NaN;
    if (t === tag && TT_KLO[idx] === lo && TT_KHI[idx] === hi) return TT_VAL[idx];
    idx = (idx + 1) & TT_MASK;
  }
  return NaN;
}
function ttStore(lo, hi, tag, val) {
  let idx = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77) ^ Math.imul(tag, 0xC2B2AE3D)) >>> 0 & TT_MASK;
  for (let p = 0; p < TT_PROBE; p++) {
    const t = TT_TAG[idx];
    if (t === 0 || (t === tag && TT_KLO[idx] === lo && TT_KHI[idx] === hi)) {
      TT_TAG[idx] = tag; TT_KLO[idx] = lo; TT_KHI[idx] = hi; TT_VAL[idx] = val; return;
    }
    idx = (idx + 1) & TT_MASK;
  }
  TT_TAG[idx] = tag; TT_KLO[idx] = lo; TT_KHI[idx] = hi; TT_VAL[idx] = val;
}

// ---------- Expectimax ----------
let NODE_BUDGET = 0, NODE_COUNT = 0;
const EMPTY_IDX = new Int32Array(16); let EMPTY_N = 0;
function collectEmpty(lo, hi) {
  EMPTY_N = 0;
  let r;
  r = lo & 0xFFFF;        if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 0;  if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 1;  if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 2;  if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 3;
  r = (lo >>> 16) & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 4;  if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 5;  if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 6;  if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 7;
  r = hi & 0xFFFF;        if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 8;  if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 9;  if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 10; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 11;
  r = (hi >>> 16) & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 12; if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 13; if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 14; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 15;
  return EMPTY_N;
}
const SNAP = []; for (let i = 0; i < 10; i++) SNAP.push(new Int32Array(16));
function countEmpty(lo, hi) {
  let n = 0, r;
  r = lo & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (lo>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = hi & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (hi>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  return n;
}

function exitimax(lo, hi, depth, player, limit) {
  if (depth === 0) return evaluate(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);
  const tag = (depth << 1) | player;
  const cached = ttLookup(lo, hi, tag);
  if (cached === cached) return cached;
  let result;
  if (player) {
    let best = -Infinity;
    for (let i = 0; i < 4; i++) {
      B_LO = lo; B_HI = hi;
      if (!moveDir(i)) continue;
      const cl = B_LO, ch = B_HI;
      const v = exitimax(cl, ch, depth - 1, false, limit);
      if (v > best) best = v;
    }
    result = best === -Infinity ? evaluate(lo, hi) - 1e12 : best;
  } else {
    const nEmp = collectEmpty(lo, hi);
    if (!nEmp) result = exitimax(lo, hi, depth - 1, true, limit);
    else {
      const snap = SNAP[depth < 10 ? depth : 9];
      for (let k = 0; k < nEmp; k++) snap[k] = EMPTY_IDX[k];
      const cap = nEmp <= 8 ? nEmp : (depth >= 5 ? limit : (limit > 10 ? limit : 10));
      const n = nEmp > cap ? cap : nEmp;
      let sum = 0;
      const offset = n < nEmp ? ((rng() * nEmp) | 0) : 0;
      for (let i = 0; i < n; i++) {
        const samplePos = n < nEmp ? (offset + Math.floor(i * nEmp / n)) % nEmp : i;
        const idx = snap[samplePos];
        const rr = (idx / 4) | 0, cc = idx % 4;
        const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
        let l2 = lo, h2 = hi, l4 = lo, h4 = hi;
        if (rr < 2) { l2 = (lo | (1 << sh)) >>> 0; l4 = (lo | (2 << sh)) >>> 0; }
        else { h2 = (hi | (1 << sh)) >>> 0; h4 = (hi | (2 << sh)) >>> 0; }
        sum += 0.9 * exitimax(l2, h2, depth - 1, true, limit);
        sum += 0.1 * exitimax(l4, h4, depth - 1, true, limit);
      }
      result = sum / n;
    }
  }
  ttStore(lo, hi, tag, result);
  return result;
}

function bestMove(lo, hi, depth, limit, budget) {
  NODE_COUNT = 0; NODE_BUDGET = budget;
  let best = -Infinity, pick = [];
  const order = [0, 2, 1, 3];
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    B_LO = lo; B_HI = hi;
    if (!moveDir(i)) continue;
    const cl = B_LO, ch = B_HI;
    const v = exitimax(cl, ch, depth - 1, false, limit);
    if (v > best + 1e-7) { best = v; pick = [i]; }
    else if (Math.abs(v - best) <= 1e-7) pick.push(i);
  }
  return pick.length ? pick[(rng() * pick.length) | 0] : -1;
}

function playGame(depth, limit, budget, seed) {
  if (seed !== undefined && seed !== null) rng = mulberry32(seed >>> 0);
  TT_TAG.fill(0);
  B_LO = 0; B_HI = 0;
  for (let k = 0; k < 2; k++) {
    collectEmpty(B_LO, B_HI);
    const idx = EMPTY_IDX[(rng() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = rng() < 0.9 ? 1 : 2;
    if (rr < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
  }
  let score = 0, steps = 0, maxExp = 0;
  while (steps < 300000) {
    const lo = B_LO, hi = B_HI;
    const empty = countEmpty(lo, hi);
    const d = depth + (empty <= 3 ? 1 : 0);
    const mv = bestMove(lo, hi, d, limit, budget);
    if (mv < 0) break;
    B_LO = lo; B_HI = hi;
    if (!moveDir(mv)) break;
    score += G;
    collectEmpty(B_LO, B_HI);
    if (EMPTY_N === 0) break;
    const idx = EMPTY_IDX[(rng() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = rng() < 0.9 ? 1 : 2;
    if (rr < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
    steps++;
    let can = false; const sl = B_LO, shh = B_HI;
    for (let i = 0; i < 4; i++) { B_LO = sl; B_HI = shh; if (moveDir(i)) { can = true; break; } }
    B_LO = sl; B_HI = shh;
    if (!can) break;
  }
  readCells(B_LO, B_HI);
  for (let i = 0; i < 16; i++) if (CELLS[i] > maxExp) maxExp = CELLS[i];
  return { score, steps, maxExp };
}

module.exports = { playGame, setParams, getParams: () => P, evaluate, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), countEmpty, getGain: () => G, setSeed, clearSeed, ENGINE_TAG };
