/*
 * 2048 引擎 v7.2inc —— ttfix + 增量/查表优化 + 动作排序（任务6）
 * ==========================================================================
 * 在不改变评估语义的前提下做三项速度优化：
 *
 * 1) 行/列单调性 MAX 折叠表
 *    评估热点中 ROW_INC/ROW_DEC（列同理）总是以 max(i,d) 形式出现，
 *    预计算 ROW_MONO_MAX/COL_MONO_MAX 后每行/列省一次查表，
 *    求和顺序与原实现完全一致 → evaluate 结果逐位（bit-exact）相同。
 *
 * 2) 叶子评估 memo 缓存（ECache）
 *    exitimax 在 depth=0 与预算耗尽时直接调 evaluate 且不经过 TT，
 *    叶子占节点数的大头；同一棋盘在兄弟分支/相邻步中重复出现时直接命中。
 *    键 = (lo,hi) 精确 64 位（两个 Uint32Array 存储），每局随 TT 一起清空。
 *
 * 3) 玩家节点动作排序
 *    按子局面「空位数千 + 得分/1024」降序探索，让可能更优的分支先入 TT，
 *    提高转置命中率、减少预算截断下的重复展开。max 节点与顺序无关，
 *    排序不消耗随机数；仅在预算截断发生时结果才可能与 ttfix 不同（如实报告）。
 *
 * 差分测试（experiments/_difftest.js）：
 *   - evaluate 与 baseline/ttfix 逐位一致；
 *   - 大预算下 bestMove 与 ttfix 同种子完全一致；
 *   - moveDir/计分/生成位置与参考实现一致。
 */
'use strict';

const ENGINE_TAG = 'v7.2-inc';

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

const SNAKE_POS = new Int32Array([
   0,  1,  2,  3,
   7,  6,  5,  4,
   8,  9, 10, 11,
  15, 14, 13, 12
]);

let P = {
  base: 4.5,
  wEmpty: 60000,
  wMono: 3.0,
  wSmooth: 6.0,
  dEmpty1: 400000,
  dEmpty2: 60000,
  phaseExp: 12,
  wMobility: 0,
  wMerge: 0,
  wCorner: 0,
  wDeadEnd: 0,
  sampleMode: 0,
  // 实测结论（experiments/results/）：排序+memo 组合损害棋力（8192率 15.0%→3.3%），
  // 默认关闭；折叠表单调性（bit-exact，240局配对一致）带来 +16.5% 纯速度收益，保持开启。
  useMoveOrder: 0,   // 动作排序开关（1=开，实验用）
  useEvalMemo: 0,    // 叶子评估 memo 开关（1=开，实验用）
  deepOnMaxExp: 0    // 最大方块 ≥ 2^该值 时深度 +1（如 13=8192 后 d7 终盘加深；
                     // 配对实验：均分 +3.7%、2048 率 100%、早崩 0%，自 v7.3prob 移植）
};

const ROW_SNAKE_BY_R = [];
const ROW_SUM_BY_R = [];
const ROW_EMPTY_CNT = new Uint8Array(ROW_LUT_SIZE);
const ROW_INC = new Float64Array(ROW_LUT_SIZE);
const ROW_DEC = new Float64Array(ROW_LUT_SIZE);
const ROW_SMOOTH = new Float64Array(ROW_LUT_SIZE);
const COL_INC = new Float64Array(ROW_LUT_SIZE);
const COL_DEC = new Float64Array(ROW_LUT_SIZE);
const COL_SMOOTH = new Float64Array(ROW_LUT_SIZE);
// 折叠表：每行/列的单调性主值 max(inc, dec)
const ROW_MONO_MAX = new Float64Array(ROW_LUT_SIZE);
const COL_MONO_MAX = new Float64Array(ROW_LUT_SIZE);

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
    ROW_MONO_MAX[row] = inc > dec ? inc : dec;
    COL_MONO_MAX[row] = inc > dec ? inc : dec;
  }
}
buildCommonTables();
buildTables(P.base);
function setParams(np) { P = Object.assign({}, P, np); buildTables(P.base); }

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

// ---------- 评估（折叠查表，逐位等价于 baseline）----------
function evaluate(lo, hi) {
  const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
  let s = ROW_SNAKE_BY_R[0][r0] + ROW_SNAKE_BY_R[1][r1] + ROW_SNAKE_BY_R[2][r2] + ROW_SNAKE_BY_R[3][r3];
  let mono = ROW_MONO_MAX[r0] + ROW_MONO_MAX[r1] + ROW_MONO_MAX[r2] + ROW_MONO_MAX[r3];
  const c0 = ((r0 & 0xF000)) | ((r1 & 0xF000) >>> 4) | ((r2 & 0xF000) >>> 8) | ((r3 & 0xF000) >>> 12);
  const c1 = ((r0 & 0x0F00) << 4) | (r1 & 0x0F00) | ((r2 & 0x0F00) >>> 4) | ((r3 & 0x0F00) >>> 8);
  const c2 = ((r0 & 0x00F0) << 8) | ((r1 & 0x00F0) << 4) | (r2 & 0x00F0) | ((r3 & 0x00F0) >>> 4);
  const c3 = ((r0 & 0x000F) << 12) | ((r1 & 0x000F) << 8) | ((r2 & 0x000F) << 4) | (r3 & 0x000F);
  mono += COL_MONO_MAX[c0] + COL_MONO_MAX[c1] + COL_MONO_MAX[c2] + COL_MONO_MAX[c3];
  let smooth = ROW_SMOOTH[r0] + ROW_SMOOTH[r1] + ROW_SMOOTH[r2] + ROW_SMOOTH[r3]
             + COL_SMOOTH[c0] + COL_SMOOTH[c1] + COL_SMOOTH[c2] + COL_SMOOTH[c3];
  const empty = ROW_EMPTY_CNT[r0] + ROW_EMPTY_CNT[r1] + ROW_EMPTY_CNT[r2] + ROW_EMPTY_CNT[r3];
  s += mono * P.wMono;
  s -= smooth * P.wSmooth;
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

// ---------- 平坦 TT ----------
const TT_BITS = 21;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_KLO = new Uint32Array(TT_SIZE);
const TT_KHI = new Uint32Array(TT_SIZE);
const TT_TAG = new Uint8Array(TT_SIZE);
const TT_VAL = new Float64Array(TT_SIZE);
const TT_PROBE = 8;

// ---------- 叶子评估 memo（键=棋盘本身，每局清空）----------
const EC_BITS = 20;
const EC_SIZE = 1 << EC_BITS;
const EC_MASK = EC_SIZE - 1;
const EC_KLO = new Uint32Array(EC_SIZE);
const EC_KHI = new Uint32Array(EC_SIZE);
const EC_TAG = new Uint8Array(EC_SIZE);   // 0=空 1=占用
const EC_VAL = new Float64Array(EC_SIZE);
const EC_PROBE = 4;
let EC_HITS = 0, EC_MISS = 0;

function evalMemo(lo, hi) {
  if (!P.useEvalMemo) return evaluate(lo, hi);
  let idx = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77)) >>> 0 & EC_MASK;
  for (let p = 0; p < EC_PROBE; p++) {
    const t = EC_TAG[idx];
    if (t === 0) break;
    if (EC_KLO[idx] === lo && EC_KHI[idx] === hi) { EC_HITS++; return EC_VAL[idx]; }
    idx = (idx + 1) & EC_MASK;
  }
  const v = evaluate(lo, hi);
  // 回填到探测起点（若探测中遇到空槽则填那里）
  let j = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77)) >>> 0 & EC_MASK;
  for (let p = 0; p < EC_PROBE; p++) {
    if (EC_TAG[j] === 0 || (EC_KLO[j] === lo && EC_KHI[j] === hi)) {
      EC_TAG[j] = 1; EC_KLO[j] = lo; EC_KHI[j] = hi; EC_VAL[j] = v; break;
    }
    j = (j + 1) & EC_MASK;
  }
  EC_MISS++;
  return v;
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

// 动作排序缓冲
const ORD_DIR = new Int32Array(4);
const ORD_PRI = new Float64Array(4);

function exitimax(lo, hi, depth, player, limit) {
  if (depth === 0) return evalMemo(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evalMemo(lo, hi);
  const tag = (depth << 1) | player;
  let idx = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77) ^ Math.imul(tag, 0xC2B2AE3D)) >>> 0 & TT_MASK;
  for (let p = 0; p < TT_PROBE; p++) {
    const t = TT_TAG[idx];
    if (t === 0) break;
    if (t === tag && TT_KLO[idx] === lo && TT_KHI[idx] === hi) return TT_VAL[idx];
    idx = (idx + 1) & TT_MASK;
  }
  let result;
  if (player) {
    let best = -Infinity;
    if (P.useMoveOrder) {
      // 收集可行动作 + 快速优先级（子局面空位数千 + 得分/1024）
      let n = 0;
      for (let i = 0; i < 4; i++) {
        B_LO = lo; B_HI = hi;
        if (!moveDir(i)) continue;
        const cl = B_LO, ch = B_HI;
        const pri = (ROW_EMPTY_CNT[cl & 0xFFFF] + ROW_EMPTY_CNT[(cl >>> 16) & 0xFFFF]
                   + ROW_EMPTY_CNT[ch & 0xFFFF] + ROW_EMPTY_CNT[(ch >>> 16) & 0xFFFF]) * 4096
                   + G / 1024;
        ORD_DIR[n] = i; ORD_PRI[n] = pri; n++;
      }
      // 插入排序（≤4 项）降序
      for (let a = 1; a < n; a++) {
        const d = ORD_DIR[a], pv = ORD_PRI[a];
        let b = a - 1;
        while (b >= 0 && ORD_PRI[b] < pv) { ORD_DIR[b + 1] = ORD_DIR[b]; ORD_PRI[b + 1] = ORD_PRI[b]; b--; }
        ORD_DIR[b + 1] = d; ORD_PRI[b + 1] = pv;
      }
      for (let a = 0; a < n; a++) {
        B_LO = lo; B_HI = hi;
        moveDir(ORD_DIR[a]);
        const cl = B_LO, ch = B_HI;
        const v = exitimax(cl, ch, depth - 1, false, limit);
        if (v > best) best = v;
      }
    } else {
      for (let i = 0; i < 4; i++) {
        B_LO = lo; B_HI = hi;
        if (!moveDir(i)) continue;
        const cl = B_LO, ch = B_HI;
        const v = exitimax(cl, ch, depth - 1, false, limit);
        if (v > best) best = v;
      }
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
        const idx2 = snap[samplePos];
        const rr = (idx2 / 4) | 0, cc = idx2 % 4;
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
  // 存入 TT
  let j = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77) ^ Math.imul(tag, 0xC2B2AE3D)) >>> 0 & TT_MASK;
  let stored = false;
  for (let p = 0; p < TT_PROBE; p++) {
    const t = TT_TAG[j];
    if (t === 0 || (t === tag && TT_KLO[j] === lo && TT_KHI[j] === hi)) {
      TT_TAG[j] = tag; TT_KLO[j] = lo; TT_KHI[j] = hi; TT_VAL[j] = result; stored = true; break;
    }
    j = (j + 1) & TT_MASK;
  }
  if (!stored) { TT_TAG[j] = tag; TT_KLO[j] = lo; TT_KHI[j] = hi; TT_VAL[j] = result; }
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
  EC_TAG.fill(0); EC_HITS = 0; EC_MISS = 0;
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
    let d = depth + (empty <= 3 ? 1 : 0);
    if (P.deepOnMaxExp > 0) {
      // 当前最大方块指数（轻量 nibble 扫描，仅当终盘加深开启时付出）
      let cur = 0;
      let w = lo & 0xFFFF;      { let v=(w>>>12)&0xF; if(v>cur)cur=v; v=(w>>>8)&0xF; if(v>cur)cur=v; v=(w>>>4)&0xF; if(v>cur)cur=v; v=w&0xF; if(v>cur)cur=v; }
      w = (lo >>> 16) & 0xFFFF; { let v=(w>>>12)&0xF; if(v>cur)cur=v; v=(w>>>8)&0xF; if(v>cur)cur=v; v=(w>>>4)&0xF; if(v>cur)cur=v; v=w&0xF; if(v>cur)cur=v; }
      w = hi & 0xFFFF;          { let v=(w>>>12)&0xF; if(v>cur)cur=v; v=(w>>>8)&0xF; if(v>cur)cur=v; v=(w>>>4)&0xF; if(v>cur)cur=v; v=w&0xF; if(v>cur)cur=v; }
      w = (hi >>> 16) & 0xFFFF; { let v=(w>>>12)&0xF; if(v>cur)cur=v; v=(w>>>8)&0xF; if(v>cur)cur=v; v=(w>>>4)&0xF; if(v>cur)cur=v; v=w&0xF; if(v>cur)cur=v; }
      maxExp = cur;
      if (cur >= P.deepOnMaxExp) d += 1;
    }
    if (d > 9) d = 9;
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

module.exports = { playGame, setParams, getParams: () => P, evaluate, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), countEmpty, getGain: () => G, setSeed, clearSeed, getMemoStats: ()=>({hits: EC_HITS, miss: EC_MISS}), ENGINE_TAG };
