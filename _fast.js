/*
 * 2048 极速内核（零分配版）
 * ------------------------------------------------------------
 * 相比 v2/v3/v4：
 *   1) 用全局 lo/hi 变量 + 直接位运算，消灭每节点 {lo,hi} 对象分配
 *   2) 行/列移动只走 LUT，不构造中间数组
 *   3) 转置表用两级 Map（避免大 key 的字符串化开销），并用 typed array 做快速缓存
 *   4) 评估函数内联，读 CELLS 缓冲，不做 Array.from
 * 目标：把吞吐从 ~9 局/分 提到 30+ 局/分，为“最快速模拟”打底。
 */
'use strict';

// ---------- 行 LUT ----------
const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);
const MOVE_LUT  = new Uint16Array(ROW_LUT_SIZE);
const RIGHT_LUT = new Uint16Array(ROW_LUT_SIZE);
const LEFT_ROW_IDX = new Uint8Array(ROW_LUT_SIZE);   // 每行是否有空位（用于快速判断）

function slideRowLeft(row) {
  const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
  const t = [];
  if (c0) t.push(c0); if (c1) t.push(c1); if (c2) t.push(c2); if (c3) t.push(c3);
  const out = []; let gained = 0;
  for (let i = 0; i < t.length; i++) {
    if (i + 1 < t.length && t[i] === t[i + 1]) { const nv = t[i] + 1; out.push(nv); gained += POW2[nv]; i++; }
    else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return { row: (out[0] << 12) | (out[1] << 8) | (out[2] << 4) | out[3], gained };
}
const POW2 = new Float64Array(32); for (let i = 0; i < 32; i++) POW2[i] = Math.pow(2, i);
function reverseRow(row) { return ((row & 0xF) << 12) | ((row & 0xF0) << 4) | ((row & 0xF00) >> 4) | ((row & 0xF000) >> 12); }
for (let r = 0; r < ROW_LUT_SIZE; r++) { const x = slideRowLeft(r); MOVE_LUT[r] = x.row; SCORE_LUT[r] = x.gained; }
for (let r = 0; r < ROW_LUT_SIZE; r++) { RIGHT_LUT[r] = reverseRow(MOVE_LUT[reverseRow(r)]); }

// ---------- 无分配棋盘操作 ----------
// 布局：lo 存 r0,r1 各 16 位；hi 存 r2,r3。每行 4 个 4-bit 指数，col0 在高位。
let B_LO = 0, B_HI = 0;
function rowOf(r) { return r < 2 ? (B_LO >>> (16 * r)) & 0xFFFF : (B_HI >>> (16 * (r - 2))) & 0xFFFF; }

// 返回是否有移动；结果写回 B_LO/B_HI；gained 通过全局 G 返回
let G = 0;
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
      const col = (((B_LO >>> (sh)) & 0xF) << 12) | (((B_LO >>> (16 + sh)) & 0xF) << 8)
                | (((B_HI >>> (sh)) & 0xF) << 4)  | ((B_HI >>> (16 + sh)) & 0xF);
      const ncol = dir === 2 ? MOVE_LUT[col] : RIGHT_LUT[col];
      if (ncol !== col) moved = true;
      gained += SCORE_LUT[col];
      nlo |= ((ncol >>> 12) & 0xF) << sh;          // r0
      nlo |= ((ncol >>> 8) & 0xF) << (16 + sh);     // r1
      nhi |= ((ncol >>> 4) & 0xF) << sh;            // r2
      nhi |= (ncol & 0xF) << (16 + sh);             // r3
    }
  }
  B_LO = nlo >>> 0; B_HI = nhi >>> 0; G = gained;
  return moved;
}

// ---------- 评估（全参数化，便于调参结果注入）----------
const CELLS = new Int32Array(16);
function readCells() {
  for (let r = 0; r < 4; r++) {
    const row = r < 2 ? (B_LO >>> (16 * r)) & 0xFFFF : (B_HI >>> (16 * (r - 2))) & 0xFFFF;
    CELLS[r*4] = (row >> 12) & 0xF; CELLS[r*4+1] = (row >> 8) & 0xF; CELLS[r*4+2] = (row >> 4) & 0xF; CELLS[r*4+3] = row & 0xF;
  }
}
const DIFF = new Float64Array(16 * 16);
for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) DIFF[a*16+b] = (a&&b) ? Math.abs(POW2[a]-POW2[b]) : 0;

let EVAL_PARAMS = { decay: 0.25, wEmpty: 3000, wMono: 1.0, wSmooth: 1.5, wCorner: 1.0 };
let WQ = new Float64Array(16), VWQ = [];
function buildEvalTables(P) {
  EVAL_PARAMS = P;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) WQ[r*4+c] = Math.pow(P.decay, r + c);
  VWQ = [];
  for (let i = 0; i < 16; i++) { const row = new Float64Array(16); for (let e = 0; e < 16; e++) row[e] = e === 0 ? 0 : POW2[e] * WQ[i]; VWQ.push(row); }
}
buildEvalTables(EVAL_PARAMS);

function evaluate() {
  readCells();
  const c = CELLS, P = EVAL_PARAMS;
  let s = 0, empty = 0, maxExp = 0, maxPos = 0;
  for (let i = 0; i < 16; i++) {
    const e = c[i];
    if (e === 0) { empty++; continue; }
    s += VWQ[i][e];
    if (e > maxExp) { maxExp = e; maxPos = i; }
  }
  s += empty * empty * P.wEmpty;
  let mono = 0;
  for (let r = 0; r < 4; r++) { let inc = 0, dec = 0; const b = r*4; for (let j = 0; j < 3; j++) { const a = c[b+j], d2 = c[b+j+1]; if (a && d2) { const d = DIFF[a*16+d2]; if (d2 > a) dec += d; else inc += d; } } mono += inc > dec ? inc : dec; }
  for (let col = 0; col < 4; col++) { let inc = 0, dec = 0; for (let r = 0; r < 3; r++) { const a = c[r*4+col], d2 = c[(r+1)*4+col]; if (a && d2) { const d = DIFF[a*16+d2]; if (d2 > a) dec += d; else inc += d; } } mono += inc > dec ? inc : dec; }
  s += mono * P.wMono;
  let smooth = 0;
  for (let r = 0; r < 4; r++) { const b = r*4; for (let j = 0; j < 3; j++) smooth += DIFF[c[b+j]*16 + c[b+j+1]]; }
  for (let col = 0; col < 4; col++) for (let r = 0; r < 3; r++) smooth += DIFF[c[r*4+col]*16 + c[(r+1)*4+col]];
  s -= smooth * P.wSmooth;
  if (maxPos !== 0) { const dist = ((maxPos/4)|0) + (maxPos%4); s -= POW2[maxExp] * WQ[0] * P.wCorner * dist; }
  if (empty <= 1) s -= 400000; else if (empty === 2) s -= 40000;
  return s;
}

// ---------- Expectimax（无分配：用显式栈变量保存/恢复 lo/hi）----------
// 因为 moveDir/setCell 都写全局，递归时需要手动保存恢复。
let TT1 = new Map();
let NODE_BUDGET = 0, NODE_COUNT = 0;                        // 单次搜索预算（普通）
let FAST_BUDGET = 0, FAST_COUNT = 0;                        // 快速模式计数（整局共享）

// 用数组做棋盘栈（比对象快）
const ST_LO = new Int32Array(64), ST_HI = new Int32Array(64);

function exitimax(lo, hi, depth, player, limit, useFast) {
  if (depth === 0) { B_LO = lo; B_HI = hi; return evaluate(); }
  if (useFast) { if (++FAST_COUNT > FAST_BUDGET) { B_LO = lo; B_HI = hi; return evaluate(); } }
  else { if (++NODE_COUNT > NODE_BUDGET) { B_LO = lo; B_HI = hi; return evaluate(); } }
  const key = player ? ((depth << 1) | 1) * 4294967296 + lo * 65536 + hi
                     : (depth << 1) * 4294967296 + lo * 65536 + hi;
  const cached = TT1.get(key); if (cached !== undefined) return cached;
  let result;
  if (player) {
    let best = -Infinity;
    for (let i = 0; i < 4; i++) {
      B_LO = lo; B_HI = hi;
      if (!moveDir(i)) continue;
      const v = exitimax(B_LO, B_HI, depth - 1, false, limit, useFast);
      if (v > best) best = v;
    }
    result = best === -Infinity ? (B_LO = lo, B_HI = hi, evaluate()) - 1e12 : best;
  } else {
    B_LO = lo; B_HI = hi;
    const empties = emptyCells();       // 写 EMPTY_IDX
    const nEmp = EMPTY_N;
    if (!nEmp) result = exitimax(lo, hi, depth - 1, true, limit, useFast);
    else {
      const cap = depth >= 5 ? limit : (limit > 10 ? limit : 10);
      const n = nEmp > cap ? cap : nEmp;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const idx = EMPTY_IDX[(Math.random() * nEmp) | 0];
        const r = (idx / 4) | 0, cc = idx % 4;
        const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * cc);
        // 放 2
        let l2 = lo, h2 = hi;
        if (r < 2) l2 = (lo | (1 << sh)) >>> 0; else h2 = (hi | (1 << sh)) >>> 0;
        sum += 0.9 * exitimax(l2, h2, depth - 1, true, limit, useFast);
        // 放 4
        let l4 = lo, h4 = hi;
        if (r < 2) l4 = (lo | (2 << sh)) >>> 0; else h4 = (hi | (2 << sh)) >>> 0;
        sum += 0.1 * exitimax(l4, h4, depth - 1, true, limit, useFast);
      }
      result = sum / n;
    }
  }
  if (TT1.size < 150000) TT1.set(key, result);
  B_LO = lo; B_HI = hi;
  return result;
}

const EMPTY_IDX = new Int32Array(16); let EMPTY_N = 0;
function emptyCells() {
  EMPTY_N = 0;
  for (let r = 0; r < 4; r++) {
    const row = r < 2 ? (B_LO >>> (16 * r)) & 0xFFFF : (B_HI >>> (16 * (r - 2))) & 0xFFFF;
    if (((row >> 12) & 0xF) === 0) EMPTY_IDX[EMPTY_N++] = r*4;
    if (((row >> 8) & 0xF) === 0) EMPTY_IDX[EMPTY_N++] = r*4+1;
    if (((row >> 4) & 0xF) === 0) EMPTY_IDX[EMPTY_N++] = r*4+2;
    if ((row & 0xF) === 0) EMPTY_IDX[EMPTY_N++] = r*4+3;
  }
}

function countEmpty(lo, hi) {
  let n = 0;
  for (let r = 0; r < 4; r++) {
    const row = r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
    if (((row >> 12) & 0xF) === 0) n++; if (((row >> 8) & 0xF) === 0) n++;
    if (((row >> 4) & 0xF) === 0) n++; if ((row & 0xF) === 0) n++;
  }
  return n;
}

function bestMove(lo, hi, depth, limit, budget, useFast) {
  if (useFast) FAST_COUNT = 0; else { NODE_COUNT = 0; NODE_BUDGET = budget; }
  let best = -Infinity, pickD = -1, pick2 = -1, nPick = 0;
  const order = [0, 2, 1, 3];
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    B_LO = lo; B_HI = hi;
    if (!moveDir(i)) continue;
    const v = exitimax(B_LO, B_HI, depth - 1, false, limit, useFast);
    if (v > best + 1e-7) { best = v; pickD = i; nPick = 1; }
    else if (v > best - 1e-7) { if (nPick === 1) pick2 = i; nPick++; }
  }
  if (nPick === 0) return -1;
  if (nPick === 1) return pickD;
  // 平手随机（只在前两个里随机，足够）
  return Math.random() < 0.5 ? pickD : pick2;
}

// ---------- 一局 ----------
function playGame(depth, limit, budget, useFast) {
  B_LO = 0; B_HI = 0;
  for (let k = 0; k < 2; k++) {
    emptyCells();
    const idx = EMPTY_IDX[(Math.random() * EMPTY_N) | 0];
    const r = (idx / 4) | 0, c = idx % 4;
    const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
    const e = Math.random() < 0.9 ? 1 : 2;
    if (r < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
  }
  let score = 0, steps = 0, maxExp = 0;
  if (useFast) FAST_BUDGET = budget;
  while (steps < 100000) {
    const lo = B_LO, hi = B_HI;
    const empty = countEmpty(lo, hi);
    const d = depth + (empty <= 3 ? 1 : 0);
    const mv = bestMove(lo, hi, d, limit, budget, useFast);
    if (mv < 0) break;
    B_LO = lo; B_HI = hi;
    if (!moveDir(mv)) break;
    score += G;
    emptyCells();
    if (EMPTY_N === 0) break;
    const idx = EMPTY_IDX[(Math.random() * EMPTY_N) | 0];
    const r = (idx / 4) | 0, c = idx % 4;
    const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
    const e = Math.random() < 0.9 ? 1 : 2;
    if (r < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
    steps++;
    let can = false; const saveL = B_LO, saveH = B_HI;
    for (let i = 0; i < 4; i++) { B_LO = saveL; B_HI = saveH; if (moveDir(i)) { can = true; break; } }
    B_LO = saveL; B_HI = saveH;
    if (!can) break;
  }
  readCells();
  for (let i = 0; i < 16; i++) if (CELLS[i] > maxExp) maxExp = CELLS[i];
  return { score, steps, maxExp };
}

module.exports = { playGame, buildEvalTables, getBoard: () => ({ lo: B_LO, hi: B_HI }), MOVE_LUT, RIGHT_LUT, SCORE_LUT };

// ---------- 直接运行：速度 & 成绩基准 ----------
if (require.main === module) {
  const P = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : EVAL_PARAMS;
  buildEvalTables(P);
  const MAX_GAMES = parseInt(process.env.MAX_GAMES || '40', 10);
  const DEPTH = parseInt(process.env.DEPTH || '5', 10);
  const LIMIT = parseInt(process.env.LIMIT || '6', 10);
  const BUDGET = parseInt(process.env.BUDGET || '45000', 10);
  const FAST = process.env.FAST === '1';
  console.log(`极速内核启动 | depth=${DEPTH} limit=${LIMIT} budget=${BUDGET} fast=${FAST}`);
  console.log('参数:', JSON.stringify(P));
  const START = Date.now();
  let bestScore = -1, bestMax = 0, sum = 0, hist = [];
  for (let g = 1; g <= MAX_GAMES; g++) {
    TT1.clear();
    const r = playGame(DEPTH, LIMIT, BUDGET, FAST);
    sum += r.score; hist.push(r.score);
    if (r.score > bestScore) {
      bestScore = r.score; bestMax = r.maxExp;
      const el = ((Date.now()-START)/1000).toFixed(0);
      console.log(`[新纪录] 第 ${g} 局 | ${r.score} 分 | 最大块 ${POW2[r.maxExp]} | ${r.steps} 步 | ${el}s`);
    }
    if (g % 5 === 0) {
      const el = (Date.now()-START)/1000;
      console.log(`  …${g} 局 | 均分 ${(sum/g).toFixed(0)} | 最高 ${bestScore} | ${(g/el*60).toFixed(1)} 局/分`);
    }
  }
  console.log(`\n===== 结果 =====`);
  console.log(`局数 ${MAX_GAMES} | 耗时 ${((Date.now()-START)/1000).toFixed(0)}s | 速率 ${(MAX_GAMES/((Date.now()-START)/1000)*60).toFixed(1)} 局/分`);
  console.log(`平均 ${(sum/MAX_GAMES).toFixed(0)} | 最高 ${bestScore} (最大块 ${POW2[bestMax]})`);
}
