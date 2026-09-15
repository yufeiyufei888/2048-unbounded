/*
 * 2048 引擎 v7 —— v3 策略 × 极速内核（混合体）
 * ==========================================================================
 * 已确认的事实：
 *   - v3（指数蛇形权重 4^(15-k) + 对象棋盘）depth5 → 均分 34,864，已打出 8192。
 *   - v6（排序式评估 + 全局 lo/hi 极速内核）depth5 → 均分 17,422，只到 2048。
 *   ⇒ 策略强度来自 v3 的「指数蛇形权重」，它是强结构约束。
 *     之前认为它"退化"，其实是把「深搜能弥补粗评估」误判成缺陷。
 *     指数权重 = 硬约束（任何时候都别破坏蛇形次序），
 *     评估看不清的细节由 depth5 搜索去分辨。
 *
 * v7.1 = 指数蛇形权重（v3 的策略，默认 base=4.5） + v6 的极速内核（全局 lo/hi、无分配、行查表）
 *        96 局复测：均分 79,514，最高 176,564，最大块 8192；16384 尚未稳定突破。
 *      目标：同样强度但快得多 → 从而负担得起更高质量搜索 → 冲击更高分。
 *
 * 为兼顾速度与表达力，v7 用「行级蛇形查表」：
 *   每行独立一张 65536 表，存 Σ 2^e * SNAKE_W[位次] 与 2^e 之和，
 *   评估时只需 4 次行查表 + 少量列修正。
 *
 * ⚠️ 已修复的致命 bug（曾导致均分只有 3,782，比 v3 低 9 倍）：
 *   全局空位缓冲 EMPTY_IDX 会被递归调用覆盖。
 *   exitimax 随机分支原本写成：
 *       for (i=0;i<n;i++) { const idx = EMPTY_IDX[rand*nEmp|0]; ... }
 *   第 2 次迭代时，EMPTY_IDX 已被上一轮递归的子节点空位列表覆盖，
 *   于是采样到"非空格"的格子索引，把方块 OR 到已有方块上 → 搜索中的棋盘被破坏
 *   → 深层评估全乱 → AI 乱走、早死（250 步就满盘）。
 *   修复：先把空位快照到 SNAP[depth] 局部缓冲，循环中只读快照。
 *   修复后：均分 3,782 → 30,750（8×），每步节点 1,030 → 1,969。
 *
 * 本轮速度进化：
 *   - 空位 ≤ 8 时全采样，减少低空位随机噪声并提高残局判断稳定性；
 *   - 列方向评估预计算为 65536 项查表，消除热点数组创建与逐格循环。
 *   - 评估函数差分 50,000 局面零误差；纯评估基准约 208ms → 113ms（1.84×）。
 *   - 600 局实测：均分 34,561，中位 32,876，最高 113,640 / 8192，早崩率 15%。
 */
'use strict';

const POW2 = new Float64Array(40);
for (let i = 0; i < 40; i++) POW2[i] = Math.pow(2, i);

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
  base: 4.5,      // 蛇形权重底数：96 局复测优于 4.0，保留可由 setParams 覆盖
  wEmpty: 60000,  // 空格奖励（线性，与 v3 一致）
  wMono: 3.0,     // 单调性
  wSmooth: 6.0,   // 平滑度
  dEmpty1: 400000,
  dEmpty2: 60000,
  // 高阶目标实验项：默认关闭，确保 v7 基线完全不变。
  phaseExp: 12,   // 从 4096/8192 阶段开始启用风险与机会项
  wMobility: 0,   // 可行动方向数，按最高方块尺度放大
  wMerge: 0,      // 当前局面可立即合并的潜力，按最高方块尺度放大
  wCorner: 0,     // 最高方块在蛇形路径前端的贴角程度
  wDeadEnd: 0     // 低可行动性惩罚，按最高方块尺度放大
};

// ---------- 行级蛇形查表（每行一张）----------
const ROW_SNAKE_BY_R = [];   // [r][rowBits] = Σ 2^e * SNAKE_W[SNAKE_POS[r*4+c]]
const ROW_SUM_BY_R = [];     // [r][rowBits] = Σ 2^e
const ROW_EMPTY_CNT = new Uint8Array(ROW_LUT_SIZE);
const ROW_INC = new Float64Array(ROW_LUT_SIZE);
const ROW_DEC = new Float64Array(ROW_LUT_SIZE);
const ROW_SMOOTH = new Float64Array(ROW_LUT_SIZE);
// 列方向同样预计算：列 bits 按上→下编码，避免 evaluate 热点中创建数组和循环
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
    // 列编码也是四个指数按上→下排列，复用同一张局部表。
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

// ---------- 评估：行表主项 + 列查表 ----------
function evaluate(lo, hi) {
  const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
  let s = ROW_SNAKE_BY_R[0][r0] + ROW_SNAKE_BY_R[1][r1] + ROW_SNAKE_BY_R[2][r2] + ROW_SNAKE_BY_R[3][r3];
  // 单调性（行）
  let mono = 0;
  { const i = ROW_INC[r0], d = ROW_DEC[r0]; mono += i > d ? i : d; }
  { const i = ROW_INC[r1], d = ROW_DEC[r1]; mono += i > d ? i : d; }
  { const i = ROW_INC[r2], d = ROW_DEC[r2]; mono += i > d ? i : d; }
  { const i = ROW_INC[r3], d = ROW_DEC[r3]; mono += i > d ? i : d; }
  // 列方向：查表替代数组创建与 12 次逐格循环
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
  // 空格
  const empty = ROW_EMPTY_CNT[r0] + ROW_EMPTY_CNT[r1] + ROW_EMPTY_CNT[r2] + ROW_EMPTY_CNT[r3];
  s += empty * P.wEmpty;
  if (empty <= 1) s -= P.dEmpty1;
  else if (empty === 2) s -= P.dEmpty2;

  // 高阶目标实验项：仅在至少一个权重非零时计算，基线不增加热点开销。
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

// ---------- Expectimax ----------
const DIRS = [0, 1, 2, 3];
let TT = new Map();
let NODE_BUDGET = 0, NODE_COUNT = 0;
// 注意：EMPTY_IDX 是全局复用缓冲，递归中会被深层调用覆盖。
// 因此凡是要在循环中多次读取的调用方，必须先把结果快照到局部数组（见 exitimax 随机分支）。
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
// 深度受限的局部快照缓冲：depth 0..8，每层独立，避免递归覆盖
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
  const key = (player ? (depth << 1) | 1 : depth << 1) * 4294967296 + lo * 65536 + hi;
  const cached = TT.get(key);
  if (cached !== undefined) return cached;   // 纯函数式：不依赖全局棋盘，无需恢复
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
      // 快照空位列表！递归会复用全局 EMPTY_IDX，不能在循环中反复读取它
      const snap = SNAP[depth < 10 ? depth : 9];
      for (let k = 0; k < nEmp; k++) snap[k] = EMPTY_IDX[k];
      // 空位已经很少时，全采样通常比随机抽样更值：树更稳定，且分支数不大。
      const cap = nEmp <= 8 ? nEmp : (depth >= 5 ? limit : (limit > 10 ? limit : 10));
      const n = nEmp > cap ? cap : nEmp;
      let sum = 0;
      // nEmp 较大时用无重复的均匀抽样，覆盖整张空位列表；
      // 比“有放回随机抽样”更少重复分支，单位预算能看到更多不同坏运气。
      const offset = n < nEmp ? ((Math.random() * nEmp) | 0) : 0;
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
  if (TT.size < 300000) TT.set(key, result);
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
  return pick.length ? pick[(Math.random() * pick.length) | 0] : -1;
}

function playGame(depth, limit, budget) {
  TT.clear();
  B_LO = 0; B_HI = 0;
  for (let k = 0; k < 2; k++) {
    collectEmpty(B_LO, B_HI);
    const idx = EMPTY_IDX[(Math.random() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = Math.random() < 0.9 ? 1 : 2;
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
    const idx = EMPTY_IDX[(Math.random() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = Math.random() < 0.9 ? 1 : 2;
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

module.exports = { playGame, setParams, getParams: () => P, evaluate, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), countEmpty };

if (require.main === module) {
  const MAX_GAMES = parseInt(process.env.MAX_GAMES || '30', 10);
  const DEPTH = parseInt(process.env.DEPTH || '5', 10);
  const LIMIT = parseInt(process.env.LIMIT || '6', 10);
  const BUDGET = parseInt(process.env.BUDGET || '45000', 10);
  if (process.env.PARAMS) setParams(JSON.parse(process.env.PARAMS));
  console.log(`引擎 v7 | depth=${DEPTH} limit=${LIMIT} budget=${BUDGET}`);
  console.log('参数', JSON.stringify(module.exports.getParams()));
  const START = Date.now();
  let bestScore = -1, bestMax = 0, sum = 0, hist = [];
  for (let g = 1; g <= MAX_GAMES; g++) {
    const r = playGame(DEPTH, LIMIT, BUDGET);
    sum += r.score; hist.push(r.score);
    if (r.score > bestScore) { bestScore = r.score; bestMax = r.maxExp; console.log(`[新纪录] 第 ${g} 局 | ${r.score} 分 | 最大块 ${POW2[r.maxExp]} | ${r.steps} 步 | ${((Date.now()-START)/1000).toFixed(0)}s`); }
    if (g % 5 === 0) { const el = (Date.now()-START)/1000; console.log(`  …${g} 局 | 均分 ${(sum/g).toFixed(0)} | 最高 ${bestScore} | ${(g/el*60).toFixed(1)} 局/分`); }
  }
  const el = (Date.now()-START)/1000;
  console.log(`\n===== v7 结果 =====`);
  console.log(`局数 ${MAX_GAMES} | 耗时 ${el.toFixed(0)}s | 速率 ${(MAX_GAMES/el*60).toFixed(1)} 局/分`);
  console.log(`平均 ${(sum/MAX_GAMES).toFixed(0)} | 最高 ${bestScore} (最大块 ${POW2[bestMax]})`);
  hist.sort((a,b)=>b-a);
  console.log(`中位 ${hist[Math.floor(hist.length/2)]} | 前5 ${hist.slice(0,5).join(', ')}`);
}

