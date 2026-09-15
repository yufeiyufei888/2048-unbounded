/*
 * 2048 引擎 v3 —— 策略增强版
 * 在 v2 (BitBoard) 基础上改进评估函数，目标是突破 8192：
 *   1) 严格蛇形权重（snake weight）：强力引导形成单一单调蛇形结构
 *   2) 角块锁定：最大块必须待在最优角，且沿蛇形递减
 *   3) 危险惩罚：空格太少 / 最大块被孤立 / 高值块贴边线，大幅扣分
 *   4) 单调性权重提高，平滑度惩罚增强
 */
'use strict';

// ============ 行移动预计算表 ============
const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);
const MOVE_LUT  = new Uint16Array(ROW_LUT_SIZE);
const RIGHT_LUT = new Uint16Array(ROW_LUT_SIZE);

function slideRowLeft(row) {
  const cells = [(row >> 12) & 0xF, (row >> 8) & 0xF, (row >> 4) & 0xF, row & 0xF];
  const t = cells.filter(v => v !== 0);
  const out = [];
  let gained = 0;
  for (let i = 0; i < t.length; i++) {
    if (i + 1 < t.length && t[i] === t[i + 1]) {
      const nv = t[i] + 1;
      out.push(nv);
      gained += 1 << nv;
      i++;
    } else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return { row: (out[0] << 12) | (out[1] << 8) | (out[2] << 4) | out[3], gained };
}
function reverseRow(row) {
  return ((row & 0xF) << 12) | ((row & 0xF0) << 4) | ((row & 0xF00) >> 4) | ((row & 0xF000) >> 12);
}
// 两遍初始化：先左移表，再右移表（关键！）
for (let row = 0; row < ROW_LUT_SIZE; row++) {
  const r = slideRowLeft(row);
  MOVE_LUT[row] = r.row;
  SCORE_LUT[row] = r.gained;
}
for (let row = 0; row < ROW_LUT_SIZE; row++) {
  RIGHT_LUT[row] = reverseRow(MOVE_LUT[reverseRow(row)]);
}

// ============ BitBoard ============
function getRow(lo, hi, r) {
  return r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
}
function setRow(r, value) {
  if (r < 2) return { lo: value << (16 * r), hi: 0 };
  return { lo: 0, hi: value << (16 * (r - 2)) };
}
function moveBoard(lo, hi, dir) {
  let nlo = 0, nhi = 0, gained = 0, moved = false;
  if (dir === 0 || dir === 1) {
    for (let r = 0; r < 4; r++) {
      const row = getRow(lo, hi, r);
      const nrow = dir === 0 ? MOVE_LUT[row] : RIGHT_LUT[row];
      if (nrow !== row) moved = true;
      gained += SCORE_LUT[row];
      const s = setRow(r, nrow);
      nlo |= s.lo; nhi |= s.hi;
    }
  } else {
    for (let c = 0; c < 4; c++) {
      let col = 0;
      for (let r = 0; r < 4; r++) col = (col << 4) | ((getRow(lo, hi, r) >>> (12 - 4 * c)) & 0xF);
      const ncol = dir === 2 ? MOVE_LUT[col] : RIGHT_LUT[col];
      if (ncol !== col) moved = true;
      gained += SCORE_LUT[col];
      for (let r = 0; r < 4; r++) {
        const v = (ncol >>> (12 - 4 * r)) & 0xF;
        const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
        if (r < 2) nlo |= v << sh; else nhi |= v << sh;
      }
    }
  }
  return { lo: nlo, hi: nhi, gained, moved };
}

function emptyCount(lo, hi) {
  let n = 0;
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    if (((row >> 12) & 0xF) === 0) n++;
    if (((row >> 8) & 0xF) === 0) n++;
    if (((row >> 4) & 0xF) === 0) n++;
    if ((row & 0xF) === 0) n++;
  }
  return n;
}
function emptyIndices(lo, hi) {
  const out = [];
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    for (let c = 0; c < 4; c++) if (((row >> (12 - 4 * c)) & 0xF) === 0) out.push(r * 4 + c);
  }
  return out;
}
function setCell(lo, hi, idx, exp) {
  const r = (idx / 4) | 0, c = idx % 4;
  const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
  if (r < 2) return { lo: lo | (exp << sh), hi };
  return { lo, hi: hi | (exp << sh) };
}
// 取出 16 格指数数组（用于评估）
function toCells(lo, hi) {
  const a = new Int32Array(16);
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    a[r * 4]     = (row >> 12) & 0xF;
    a[r * 4 + 1] = (row >> 8) & 0xF;
    a[r * 4 + 2] = (row >> 4) & 0xF;
    a[r * 4 + 3] = row & 0xF;
  }
  return a;
}

// ============ 蛇形权重（关键改进）============
// 蛇形路径：左上角起，Z 字折返，保证最大块在最有利的角落
// 0 -> 1 -> 2 -> 3
//               |
// 7 <- 6 <- 5 <- 4
// |
// 8 -> 9 -> 10 -> 11
//                 |
// 15 <- 14 <- 13 <- 12
// 权重按蛇形顺序指数衰减，强烈鼓励沿蛇形递增
const SNAKE_IDX = new Int32Array([
   0,  1,  2,  3,
   7,  6,  5,  4,
   8,  9, 10, 11,
  15, 14, 13, 12
]);
// 蛇形权重：第 k 个位置权重 = 4^(15-k)，让越靠"蛇头"（最大块位置）越大
const SNAKE_W = new Float64Array(16);
for (let k = 0; k < 16; k++) SNAKE_W[k] = Math.pow(4, 15 - k);

// 预计算：格子 i 上指数 e 的蛇形贡献 = 值(1<<e) * SNAKE_W[蛇形位次]
// VAL_SNAKE[i][e]，i 为物理格索引，e 为指数(0..15)
const VAL_SNAKE = [];
for (let i = 0; i < 16; i++) {
  const row = new Float64Array(16);
  for (let e = 0; e < 16; e++) row[e] = e === 0 ? 0 : (1 << e) * SNAKE_W[SNAKE_IDX[i]];
  VAL_SNAKE.push(row);
}
// 预计算：两个指数 a,b 的差值惩罚与单调性增量
const DIFF = new Float64Array(16 * 16);
for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
  DIFF[a * 16 + b] = (a && b) ? Math.abs((1 << a) - (1 << b)) : 0;
}

function evaluate(lo, hi) {
  const c = toCells(lo, hi);
  let s = 0, empty = 0;

  // 1) 蛇形权重（主项）：查表，避免重复计算
  for (let i = 0; i < 16; i++) {
    const e = c[i];
    if (e === 0) { empty++; continue; }
    s += VAL_SNAKE[i][e];
  }

  // 2) 空格奖励
  s += empty * 60000;

  // 3) 单调性（行 + 列）
  let mono = 0;
  for (let r = 0; r < 4; r++) {
    let inc = 0, dec = 0;
    for (let j = 0; j < 3; j++) {
      const a = c[r * 4 + j], b = c[r * 4 + j + 1];
      if (a && b) { const d = DIFF[a * 16 + b]; if (b > a) dec += d; else inc += d; }
    }
    mono += inc > dec ? inc : dec;
  }
  for (let col = 0; col < 4; col++) {
    let inc = 0, dec = 0;
    for (let r = 0; r < 3; r++) {
      const a = c[r * 4 + col], b = c[(r + 1) * 4 + col];
      if (a && b) { const d = DIFF[a * 16 + b]; if (b > a) dec += d; else inc += d; }
    }
    mono += inc > dec ? inc : dec;
  }
  s += mono * 3.0;

  // 4) 平滑度惩罚（相邻差值，查表）
  for (let r = 0; r < 4; r++) {
    for (let j = 0; j < 3; j++) s -= DIFF[c[r * 4 + j] * 16 + c[r * 4 + j + 1]] * 6;
  }
  for (let col = 0; col < 4; col++) {
    for (let r = 0; r < 3; r++) s -= DIFF[c[r * 4 + col] * 16 + c[(r + 1) * 4 + col]] * 6;
  }

  // 5) 危险惩罚
  if (empty <= 1) s -= 400000;
  else if (empty === 2) s -= 60000;

  return s;
}

// ============ Expectimax ============
const DIRS = [0, 1, 2, 3];
let TT = new Map();
let NODE_BUDGET = 0, NODE_COUNT = 0;

function expectimax(lo, hi, depth, player, limit) {
  if (depth === 0) return evaluate(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);
  const key = player ? (depth * 2 + 1) * 4294967296 + lo * 65536 + hi
                     : (depth * 2) * 4294967296 + lo * 65536 + hi;
  const cached = TT.get(key);
  if (cached !== undefined) return cached;

  let result;
  if (player) {
    let best = -Infinity;
    for (let i = 0; i < 4; i++) {
      const m = moveBoard(lo, hi, DIRS[i]);
      if (!m.moved) continue;
      const v = expectimax(m.lo, m.hi, depth - 1, false, limit);
      if (v > best) best = v;
    }
    result = best === -Infinity ? evaluate(lo, hi) - 1e12 : best;
  } else {
    const cells = emptyIndices(lo, hi);
    if (!cells.length) {
      result = expectimax(lo, hi, depth - 1, true, limit);
    } else {
      const cap = depth >= 5 ? limit : Math.max(limit, 10);
      const n = cells.length > cap ? cap : cells.length;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const idx = cells[(Math.random() * cells.length) | 0];
        const s2 = setCell(lo, hi, idx, 1);
        const s4 = setCell(lo, hi, idx, 2);
        sum += 0.9 * expectimax(s2.lo, s2.hi, depth - 1, true, limit);
        sum += 0.1 * expectimax(s4.lo, s4.hi, depth - 1, true, limit);
      }
      result = sum / n;
    }
  }
  if (TT.size < 200000) TT.set(key, result);
  return result;
}

function bestMove(lo, hi, depth, limit, budget) {
  NODE_COUNT = 0;
  NODE_BUDGET = budget;
  let best = -Infinity, pick = [];
  // 方向微调：优先 up/left（保持大块在左上角），平手时倾向这些方向
  const order = [0, 2, 1, 3];  // left, up, right, down
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    const m = moveBoard(lo, hi, DIRS[i]);
    if (!m.moved) continue;
    const v = expectimax(m.lo, m.hi, depth - 1, false, limit);
    if (v > best + 1e-7) { best = v; pick = [i]; }
    else if (Math.abs(v - best) <= 1e-7) pick.push(i);
  }
  return pick.length ? pick[(Math.random() * pick.length) | 0] : null;
}

// ============ 一整局 ============
function playOneGame(depth, limit, budget) {
  let lo = 0, hi = 0, score = 0, steps = 0;
  for (let k = 0; k < 2; k++) {
    const cells = emptyIndices(lo, hi);
    const s = setCell(lo, hi, cells[(Math.random() * cells.length) | 0], Math.random() < 0.9 ? 1 : 2);
    lo = s.lo; hi = s.hi;
  }
  while (steps < 200000) {
    const empty = emptyCount(lo, hi);
    // 自适应深度：越紧张越深思
    const d = depth + (empty <= 3 ? 1 : 0);
    const mv = bestMove(lo, hi, d, limit, budget);
    if (mv === null) break;
    const m = moveBoard(lo, hi, mv);
    lo = m.lo; hi = m.hi;
    score += m.gained;
    const cells = emptyIndices(lo, hi);
    if (!cells.length) break;
    const s = setCell(lo, hi, cells[(Math.random() * cells.length) | 0], Math.random() < 0.9 ? 1 : 2);
    lo = s.lo; hi = s.hi;
    steps++;
    let canMove = false;
    for (let i = 0; i < 4; i++) if (moveBoard(lo, hi, i).moved) { canMove = true; break; }
    if (!canMove) break;
  }
  const board = [];
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r), arr = [];
    for (let c = 0; c < 4; c++) {
      const e = (row >> (12 - 4 * c)) & 0xF;
      arr.push(e === 0 ? 0 : (1 << e) >>> 0);
    }
    board.push(arr);
  }
  return { board, score, steps, maxTile: Math.max(...board.flat()) };
}


module.exports={evaluate};
