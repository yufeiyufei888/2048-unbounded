const fs = require('fs');
let s = fs.readFileSync('_engine3.js','utf8');
const cut = s.indexOf('// ============ 主循环 ============');
s = s.slice(0, cut);
s = s.replace('function bestMove(lo, hi, depth, limit, budget) {','function bestMove(lo, hi, depth, limit, budget) { global.__MC=global.__MC||[]; global.__MC.push(0); const __mi=global.__MC.length-1;');
s = s.replace('  return pick.length ? pick[(Math.random() * pick.length) | 0] : null;','  global.__MC[__mi]=NODE_COUNT;\n  return pick.length ? pick[(Math.random() * pick.length) | 0] : null;');
s += '\nmodule.exports = { playOneGame, bestMove, expectimax, evaluate, moveBoard, setCell };\n';
fs.writeFileSync('_v3cnt.js', s);
const V3 = require('./_v3cnt.js');
function toBit(b){let lo=0,hi=0;for(let r=0;r<4;r++)for(let c=0;c<4;c++){const e=b[r][c];if(!e)continue;
  const sh=(r<2?16*r:16*(r-2))+(12-4*c);if(r<2)lo|=e<<sh;else hi|=e<<sh;}return {lo:lo>>>0,hi:hi>>>0};}
const mid = [[10,9,8,6],[7,5,4,0],[0,2,1,0],[0,0,0,0]];
const {lo,hi} = toBit(mid);
const t = Date.now();
const mv = V3.bestMove(lo,hi,5,6,40000);
console.log('中盘 v3 选择',mv,'节点',global.__MC[global.__MC.length-1],'耗时',Date.now()-t,'ms');
