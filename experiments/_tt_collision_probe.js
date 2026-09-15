// TT key 碰撞实证：构造两个真实可达的不同棋盘，检查 v7 的 Map key 是否相同
// 布局：lo = row0 | row1<<16, hi = row2 | row3<<16
const A_LO = 0x00000000, A_HI = 0x00010000; // A: 仅 row3-col3 = 2^2 (exp1)
const B_LO = 0x00000001, B_HI = 0x00000000; // B: 仅 row0-col3 = 2^2 (exp1)

function key7(player, depth, lo, hi) {
  return (player ? (depth << 1) | 1 : depth << 1) * 4294967296 + lo * 65536 + hi;
}

// 随机碰撞率估计：采样真实感随机棋盘，统计 key 去重率
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rng = mulberry32(20260915);
function randBoard() {
  let lo = 0, hi = 0;
  for (let i = 0; i < 16; i++) {
    const e = rng() < 0.45 ? 0 : 1 + Math.floor(Math.pow(rng(), 2.2) * 12);
    const sh = (i < 8 ? 4 * i : 4 * (i - 8));
    if (i < 8) lo = (lo | (e << sh)) >>> 0; else hi = (hi | (e << sh)) >>> 0;
  }
  return [lo, hi];
}

const N = 200000, DEPTH = 3;
const seen = new Map();
let coll = 0, pairs = null;
for (let i = 0; i < N; i++) {
  const [lo, hi] = randBoard();
  const k = key7(0, DEPTH, lo, hi);
  const prev = seen.get(k);
  if (prev !== undefined) {
    coll++;
    if (!pairs && (prev[0] !== lo || prev[1] !== hi)) pairs = [prev, [lo, hi]];
  } else seen.set(k, [lo, hi]);
}
console.log('构造碰撞: key(A)=', key7(0, 3, A_LO, A_HI), ' key(B)=', key7(0, 3, B_LO, B_HI), ' 相等=', key7(0, 3, A_LO, A_HI) === key7(0, 3, B_LO, B_HI));
console.log(`随机 ${N} 棋盘 @depth=${DEPTH}: 首键冲突 ${coll} 次 (${(coll / N * 100).toFixed(2)}%); 唯一棋盘 ${seen.size}`);
if (pairs) console.log('示例冲突对:', JSON.stringify(pairs));
