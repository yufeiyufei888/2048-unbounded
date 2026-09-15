// 极速反复模拟：不依赖 DOM/动画，纯逻辑引擎，尽可能快地对局，记录历史最高分
// 无上限：2048 之后继续合成 4096 / 8192 / 16384...
const MAX_GAMES = 300;        // 最多模拟局数
const TIME_LIMIT_MS = 1000 * 60 * 40;  // 40 分钟总预算
const START = Date.now();
const SAFE_MEM = 1.4 * 1024 * 1024 * 1024;  // 堆用量接近 1.4G 就主动收尾，规避 segfault

// ---------- 棋盘操作（位运算加速无意义，这里用数组更清晰）----------
function emptyGrid() { return [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]; }

function slideLine(line) {
  const t = [];
  for (let i = 0; i < 4; i++) if (line[i]) t.push(line[i]);
  const out = [];
  let gained = 0;
  for (let i = 0; i < t.length; i++) {
    if (i + 1 < t.length && t[i] === t[i + 1]) { out.push(t[i] * 2); gained += t[i] * 2; i++; }
    else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return { out, gained };
}

function simulate(b, dir) {
  const nb = emptyGrid();
  let moved = false, gained = 0;
  if (dir === 0 || dir === 1) { // left / right
    for (let r = 0; r < 4; r++) {
      let line = b[r].slice();
      if (dir === 1) line.reverse();
      const res = slideLine(line);
      const out = res.out;
      gained += res.gained;
      if (dir === 1) out.reverse();
      for (let c = 0; c < 4; c++) { nb[r][c] = out[c]; if (out[c] !== b[r][c]) moved = true; }
    }
  } else { // up / down
    for (let c = 0; c < 4; c++) {
      let col = [b[0][c], b[1][c], b[2][c], b[3][c]];
      if (dir === 3) col.reverse();
      const res = slideLine(col);
      const out = res.out;
      gained += res.gained;
      if (dir === 3) out.reverse();
      for (let r = 0; r < 4; r++) { nb[r][c] = out[r]; if (out[r] !== b[r][c]) moved = true; }
    }
  }
  return { board: nb, moved, gained };
}

function emptyCells(b) {
  const o = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!b[r][c]) o.push(r * 4 + c);
  return o;
}

function addTile(b, idx, val) {
  const nb = b.map(r => r.slice());
  nb[(idx / 4) | 0][idx % 4] = val;
  return nb;
}

// ---------- 评估函数 ----------
const W = [
  [65536, 32768, 16384, 8192],
  [512,   1024,  2048,  4096],
  [256,   128,   64,    32],
  [2,     4,     8,     16]
];
function monotonicity(b) {
  let total = 0;
  for (let r = 0; r < 4; r++) {
    let inc = 0, dec = 0;
    for (let c = 0; c < 3; c++) {
      if (b[r][c] > b[r][c+1]) dec += b[r][c+1] - b[r][c];
      else inc += b[r][c] - b[r][c+1];
    }
    total += Math.max(inc, dec);
  }
  for (let c = 0; c < 4; c++) {
    let inc = 0, dec = 0;
    for (let r = 0; r < 3; r++) {
      if (b[r][c] > b[r+1][c]) dec += b[r+1][c] - b[r][c];
      else inc += b[r][c] - b[r+1][c];
    }
    total += Math.max(inc, dec);
  }
  return total;
}
function evaluate(b) {
  let s = 0, empty = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const v = b[r][c];
    if (!v) { empty++; continue; }
    s += v * W[r][c];
  }
  s += empty * 20000;
  s += monotonicity(b) * 2.0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (c < 3 && b[r][c] && b[r][c+1]) s -= Math.abs(b[r][c] - b[r][c+1]) * 4;
    if (r < 3 && b[r][c] && b[r+1][c]) s -= Math.abs(b[r][c] - b[r+1][c]) * 4;
  }
  return s;
}

// ---------- Expectimax ----------
const DIRS = [0, 1, 2, 3];
function expectimax(b, depth, player, limit) {
  if (depth === 0) return evaluate(b);
  if (player) {
    let best = -Infinity;
    for (let i = 0; i < 4; i++) {
      const res = simulate(b, DIRS[i]);
      if (!res.moved) continue;
      const v = expectimax(res.board, depth - 1, false, limit);
      if (v > best) best = v;
    }
    return best === -Infinity ? evaluate(b) - 1e9 : best;
  }
  const cells = emptyCells(b);
  if (!cells.length) return expectimax(b, depth - 1, true, limit);
  const n = cells.length > limit ? limit : cells.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const idx = cells[(Math.random() * cells.length) | 0];
    sum += 0.9 * expectimax(addTile(b, idx, 2), depth - 1, true, limit);
    sum += 0.1 * expectimax(addTile(b, idx, 4), depth - 1, true, limit);
  }
  return sum / n;
}

function bestMove(b, depth, limit) {
  let best = -Infinity, pick = [];
  for (let i = 0; i < 4; i++) {
    const res = simulate(b, DIRS[i]);
    if (!res.moved) continue;
    const v = expectimax(res.board, depth - 1, false, limit);
    if (v > best + 1e-9) { best = v; pick = [i]; }
    else if (Math.abs(v - best) < 1e-9) pick.push(i);
  }
  return pick.length ? pick[(Math.random() * pick.length) | 0] : null;
}

function movesAvailable(b) {
  for (let i = 0; i < 4; i++) if (simulate(b, DIRS[i]).moved) return true;
  return false;
}

// ---------- 模拟一整局（纯逻辑，零延时）----------
function playOneGame(depth, limit) {
  let b = emptyGrid();
  let score = 0;
  // 初始两块
  for (let k = 0; k < 2; k++) {
    const cells = emptyCells(b);
    const idx = cells[(Math.random() * cells.length) | 0];
    b = addTile(b, idx, Math.random() < 0.9 ? 2 : 4);
  }
  let steps = 0;
  while (steps < 100000) {
    const mv = bestMove(b, depth, limit);
    if (mv === null) break;
    const res = simulate(b, mv);
    b = res.board;
    score += res.gained;      // 合并所得分数
    // 新方块
    const cells = emptyCells(b);
    if (!cells.length) break;
    const idx = cells[(Math.random() * cells.length) | 0];
    b = addTile(b, idx, Math.random() < 0.9 ? 2 : 4);
    steps++;
    if (!movesAvailable(b)) break;
  }
  return { board: b, score, steps, maxTile: Math.max(...b.flat()) };
}
function sumBoard(b) { let s = 0; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s += b[r][c]; return s; }

// ---------- 主循环 ----------
const DEPTH = 5;
const LIMIT = 4;  // 随机节点抽样上限
let best = { score: -1 };
let games = 0;
const t0 = Date.now();

for (let g = 1; g <= MAX_GAMES; g++) {
  const r = playOneGame(DEPTH, LIMIT);
  games++;
  if (r.score > best.score) {
    best = r;
    console.log(`[新纪录] 第 ${g} 局 | 得分 ${r.score} | 最大块 ${r.maxTile} | 步数 ${r.steps} | 耗时 ${((Date.now()-t0)/1000).toFixed(0)}s`);
    r.board.forEach(row => console.log('   ' + row.map(v => String(v || '.').padStart(6)).join('')));
  }
  if (Date.now() - START > TIME_LIMIT_MS) { console.log('达到时间预算，停止'); break; }
  // 内存保护：逼近上限时主动停止，避免 segfault 丢失结果
  const used = process.memoryUsage ? process.memoryUsage().heapUsed : 0;
  if (used > SAFE_MEM) { console.log('内存接近上限，安全停止（已保留结果）'); break; }
}

console.log('\n===== 汇总 =====');
console.log('模拟局数 :', games);
console.log('总耗时   :', ((Date.now() - START) / 1000).toFixed(0) + 's');
console.log('最高得分 :', best.score);
console.log('最大方块 :', best.maxTile);
console.log('总步数   :', best.steps);
console.log('终盘 :');
best.board.forEach(row => console.log('  ' + row.map(v => String(v || '.').padStart(6)).join('')));
