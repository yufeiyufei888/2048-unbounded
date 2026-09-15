/*
 * 2048 引擎 v7.2phase —— ttfix + 高阶阶段化评估默认开启（实验分支）
 * 参数复刻此前 phaseD96 实验：phaseExp=14, wMobility=200000, wMerge=5,
 * wCorner=100000, wDeadEnd=100000。此前 96 局结果弱于基线（65,471 vs 79,514），
 * 本分支仅作为实验保留并复测。
 * ==========================================================================
 * 【已实证的 v7.1 转置表键冲突 bug】
 *   旧 key = depthTerm*2^32 + lo*65536 + hi。
 *   lo<2^32、hi<2^32，而 lo*65536 会跨过 2^32 边界、hi 又以原始值相加，
 *   因此不同棋盘可映射到同一 key。实验（experiments/_tt_collision_probe.js）：
 *     - 棋盘 A（仅 row3-col3 有 2）与棋盘 B（仅 row0-col3 有 2）key 完全相同；
 *     - 20 万随机真实感棋盘中出现 32 次跨棋盘首键冲突（0.02%）。
 *   影响：TT 偶发把 A 棋盘的搜索值错配给 B 棋盘 → 搜索被静默污染。
 *
 * 【修复方案】平坦类型数组 TT（类似 nneonneo/2048-ai 的 C++ 做法）：
 *   - 键精确存储：K_LO/K_HI 两个 Uint32Array 各存 32 位，无任何打包损失；
 *   - TAG = depth*2+player（0 表示空槽，合法 TAG ≥ 2）；
 *   - 开放寻址 + 线性探测（最多 8 槽），Math.imul 混合哈希；
 *   - 每局开始 TAG.fill(0) 清表，杜绝跨局污染；
 *   - 容量 2^21 槽 ≈ 33MB 固定内存，超过即覆盖旧条目，无 Map 的哈希开销。
 * 其余逻辑与 _engine7_baseline.js 完全一致（含种子机制）。
 */
'use strict';

const ENGINE_TAG = 'v7.2-phase';

const POW2 = new Float64Array(40);
for (let i = 0; i < 40; i++) POW2[i] = Math.pow(2, i);

// ---------- 可复现随机种子机制 ----------
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

// ---------- 行移动 LUT ----------
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

// ---------- 蛇形位次 ----------
const SNAKE_POS = new Int32Array([
   0,  1,  2,  3,
   7,  6,  5,  4,
   8,  9, 10, 11,
  15, 14, 13, 12
]);

// ---------- 参数 ----------
let P = {
  base: 4.5,
  wEmpty: 60000,
  wMono: 3.0,
  wSmooth: 6.0,
  dEmpty1: 400000,
  dEmpty2: 60000,
  phaseExp: 14,
  wMobility: 200000,
  wMerge: 5,
  wCorner: 100000,
  wDeadEnd: 100000,
  // 随机节点采样模式（任务5）：0=无重复分层抽样(v7.1基线) 1=有放回均匀 2=按蛇形位置重要性加权
  sampleMode: 0
};

// ---------- 行级蛇形查表 ----------
const ROW_SNAKE_BY_R = [];
const ROW_SUM_BY_R = [];
const ROW_EMPTY_CNT = new Uint8Array(ROW_LUT_SIZE);
const ROW_INC = new Float64Array(ROW_LUT_SIZE);
const ROW_DEC = new Float64Array(ROW_LUT_SIZE);
const ROW_SMOOTH = new Float64Array(ROW_LUT_SIZE);
const COL_INC = new Float64Array(ROW_LUT_SIZE);
const COL_DEC = new Float64Array(ROW_LUT_SIZE);
const COL_SMOOTH = new Float64Array(ROW_LUT_SIZE);

function buildTables(base) {
  const SW = new Float64Array(16);
  for (let k = 0; k < 16; k++) SW[k] = Math.pow(base, 15 - k);
  ROW_SNAKE_BY_R.length = 0; ROW_SUM_BY_R.length = 0;
  for (let r = 0; r < 4; r++) {
    const snakeTab = new Float64Array(ROW_LUT_SIZE);
    const sumTab = new Float64Array(ROW_LUT_SIZE);
    for (let row = 0; row < ROW_LUT_SIZE; row++) {
      const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
      const cs = [c0, c1, c2, c3];
      let sq = 0, sm = 0;
      for (let c = 0; c < 4; c++) {
        const e = cs[c];
        if (e === 0) continue;
        sq += POW2[e] * SW[SNAKE_POS[r * 4 + c]];
        sm += POW2[e];
      }
      snakeTab[row] = sq; sumTab[row] = sm;
    }
    ROW_SNAKE_BY_R.push(snakeTab); ROW_SUM_BY_R.push(sumTab);
  }
}
function buildCommonTables() {
  for (let row = 0; row < ROW_LUT_SIZE; row++) {
    const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
    const cs = [c0, c1, c2, c3];
    let emp = 0, smooth = 0, inc = 0, dec = 0;
    for (let c = 0; c < 4; c++) if (cs[c] === 0) emp++;
    for (let c = 0; c < 3; c++) {
      const a = cs[c], b = cs[c + 1];
      if (a && b) { const d = Math.abs(POW2[a] - POW2[b]); smooth += d; if (b > a) dec += d; else inc += d; }
    }
    ROW_EMPTY_CNT[row] = emp; ROW_SMOOTH[row] = smooth; ROW_INC[row] = inc; ROW_DEC[row] = dec;
    COL_SMOOTH[row] = smooth; COL_INC[row] = inc; COL_DEC[row] = dec;
  }
}
buildCommonTables();
buildTables(P.base);
function setParams(np) { P = Object.assign({}, P, np); buildTables(P.base); }

// ---------- 棋盘（全局 lo/hi）----------
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

// ---------- 评估 ----------
function evaluate(lo, hi) {
  const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
  let s = ROW_SNAKE_BY_R[0][r0] + ROW_SNAKE_BY_R[1][r1] + ROW_SNAKE_BY_R[2][r2] + ROW_SNAKE_BY_R[3][r3];
  let mono = 0;
  { const i = ROW_INC[r0], d = ROW_DEC[r0]; mono += i > d ? i : d; }
  { const i = ROW_INC[r1], d = ROW_DEC[r1]; mono += i > d ? i : d; }
  { const i = ROW_INC[r2], d = ROW_DEC[r2]; mono += i > d ? i : d; }
  { const i = ROW_INC[r3], d = ROW_DEC[r3]; mono += i > d ? i : d; }
  const c0 = ((r0 & 0xF000)) | ((r1 & 0xF000) >>> 4) | ((r2 & 0xF000) >>> 8) | ((r3 & 0xF000) >>> 12);
  const c1 = ((r0 & 0x0F00) << 4) | (r1 & 0x0F00) | ((r2 & 0x0F00) >>> 4) | ((r3 & 0x0F00) >>> 8);
  const c2 = ((r0 & 0x00F0) << 8) | ((r1 & 0x00F0) << 4) | (r2 & 0x00F0) | ((r3 & 0x00F0) >>> 4);
  const c3 = ((r0 & 0x000F) << 12) | ((r1 & 0x000F) << 8) | ((r2 & 0x000F) << 4) | (r3 & 0x000F);
  let smooth = ROW_SMOOTH[r0] + ROW_SMOOTH[r1] + ROW_SMOOTH[r2] + ROW_SMOOTH[r3];
  { const i = COL_INC[c0], d = COL_DEC[c0]; mono += i > d ? i : d; smooth += COL_SMOOTH[c0]; }
  { const i = COL_INC[c1], d = COL_DEC[c1]; mono += i > d ? i : d; smooth += COL_SMOOTH[c1]; }
  { const i = COL_INC[c2], d = COL_DEC[c2]; mono += i > d ? i : d; smooth += COL_SMOOTH[c2]; }
  { const i = COL_INC[c3], d = COL_DEC[c3]; mono += i > d ? i : d; smooth += COL_SMOOTH[c3]; }
  s += mono * P.wMono;
  s -= smooth * P.wSmooth;
  const empty = ROW_EMPTY_CNT[r0] + ROW_EMPTY_CNT[r1] + ROW_EMPTY_CNT[r2] + ROW_EMPTY_CNT[r3];
  s += empty * P.wEmpty;
  if (empty <= 1) s -= P.dEmpty1;
  else if (empty === 2) s -= P.dEmpty2;

  if (P.wMobility || P.wMerge || P.wCorner || P.wDeadEnd) {
    const rows = [r0, r1, r2, r3];
    let maxExp = 0, bestRank = 15;
    for (let r = 0; r < 4; r++) {
      const row = rows[r];
      for (let c = 0; c < 4; c++) {
        const e = (row >>> (12 - 4 * c)) & 0xF;
        if (e > maxExp) { maxExp = e; bestRank = SNAKE_POS[r * 4 + c]; }
        else if (e === maxExp && e > 0 && SNAKE_POS[r * 4 + c] < bestRank) bestRank = SNAKE_POS[r * 4 + c];
      }
    }
    const phase = maxExp >= P.phaseExp ? 1 : (maxExp + 1 === P.phaseExp ? 0.35 : 0);
    if (phase) {
      const movable =
        (MOVE_LUT[r0] !== r0 || RIGHT_LUT[r0] !== r0 ? 1 : 0) +
        (MOVE_LUT[r1] !== r1 || RIGHT_LUT[r1] !== r1 ? 1 : 0) +
        (MOVE_LUT[r2] !== r2 || RIGHT_LUT[r2] !== r2 ? 1 : 0) +
        (MOVE_LUT[r3] !== r3 || RIGHT_LUT[r3] !== r3 ? 1 : 0) +
        (MOVE_LUT[c0] !== c0 || RIGHT_LUT[c0] !== c0 ? 1 : 0) +
        (MOVE_LUT[c1] !== c1 || RIGHT_LUT[c1] !== c1 ? 1 : 0) +
        (MOVE_LUT[c2] !== c2 || RIGHT_LUT[c2] !== c2 ? 1 : 0) +
        (MOVE_LUT[c3] !== c3 || RIGHT_LUT[c3] !== c3 ? 1 : 0);
      const merge = SCORE_LUT[r0] + SCORE_LUT[r1] + SCORE_LUT[r2] + SCORE_LUT[r3]
        + SCORE_LUT[c0] + SCORE_LUT[c1] + SCORE_LUT[c2] + SCORE_LUT[c3];
      const scale = POW2[maxExp];
      s += phase * (P.wMobility * movable * scale + P.wMerge * merge + P.wCorner * (15 - bestRank) * scale);
      if (movable <= 1) s -= phase * P.wDeadEnd * scale;
    }
  }
  return s;
}

// ---------- 平坦类型数组转置表（精确键，修复冲突 bug）----------
const TT_BITS = 21;                 // 2^21 ≈ 2.1M 槽
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_KLO = new Uint32Array(TT_SIZE);
const TT_KHI = new Uint32Array(TT_SIZE);
const TT_TAG = new Uint8Array(TT_SIZE);   // depth*2+player；0=空槽（合法值≥2）
const TT_VAL = new Float64Array(TT_SIZE);
const TT_PROBE = 8;

function ttLookup(lo, hi, tag) {
  let idx = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77) ^ Math.imul(tag, 0xC2B2AE3D)) >>> 0 & TT_MASK;
  for (let p = 0; p < TT_PROBE; p++) {
    const t = TT_TAG[idx];
    if (t === 0) return NaN;                       // 空槽：未命中
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
  // 探测窗满：直接覆盖起始槽（朴素替换策略）
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
// 加权采样用：格子权重 ∝ base^((15-蛇形位次)/3)，蛇头附近权重高（新方块出现在蛇头附近更具破坏性）
const CELL_W = new Float64Array(16);
function buildCellW() {
  for (let i = 0; i < 16; i++) CELL_W[i] = Math.pow(P.base, (15 - SNAKE_POS[i]) / 3);
}
buildCellW();

function exitimax(lo, hi, depth, player, limit) {
  if (depth === 0) return evaluate(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);
  const tag = (depth << 1) | player;
  const cached = ttLookup(lo, hi, tag);
  if (cached === cached) return cached;            // NaN 判空
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
      if (P.sampleMode === 1) {
        // 有放回均匀抽样
        for (let i = 0; i < n; i++) {
          const idx = snap[(rng() * nEmp) | 0];
          const rr = (idx / 4) | 0, cc = idx % 4;
          const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
          let l2 = lo, h2 = hi, l4 = lo, h4 = hi;
          if (rr < 2) { l2 = (lo | (1 << sh)) >>> 0; l4 = (lo | (2 << sh)) >>> 0; }
          else { h2 = (hi | (1 << sh)) >>> 0; h4 = (hi | (2 << sh)) >>> 0; }
          sum += 0.9 * exitimax(l2, h2, depth - 1, true, limit);
          sum += 0.1 * exitimax(l4, h4, depth - 1, true, limit);
        }
      } else if (P.sampleMode === 2) {
        // 按位置重要性加权有放回抽样（蛇头附近更容易破坏结构，被采到概率更高）
        let wsum = 0;
        for (let k = 0; k < nEmp; k++) wsum += CELL_W[snap[k]];
        for (let i = 0; i < n; i++) {
          let pick = rng() * wsum, idx = snap[nEmp - 1];
          for (let k = 0; k < nEmp; k++) { pick -= CELL_W[snap[k]]; if (pick <= 0) { idx = snap[k]; break; } }
          const rr = (idx / 4) | 0, cc = idx % 4;
          const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
          let l2 = lo, h2 = hi, l4 = lo, h4 = hi;
          if (rr < 2) { l2 = (lo | (1 << sh)) >>> 0; l4 = (lo | (2 << sh)) >>> 0; }
          else { h2 = (hi | (1 << sh)) >>> 0; h4 = (hi | (2 << sh)) >>> 0; }
          sum += 0.9 * exitimax(l2, h2, depth - 1, true, limit);
          sum += 0.1 * exitimax(l4, h4, depth - 1, true, limit);
        }
      } else {
        // v7.1 基线：无重复均匀分层抽样
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
  TT_TAG.fill(0);                                   // 每局清表，杜绝跨局污染
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

module.exports = { playGame, setParams, getParams: () => P, evaluate, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), countEmpty, getGain: () => G, setSeed, clearSeed, ttLookup, ttStore, ENGINE_TAG };
