// 更新 _mk_td.js：tdBlendUp 上限守卫 + 兄弟校准 + 独立 moveBoard LUT
const fs = require('fs');
let s = fs.readFileSync('experiments/_mk_td.js', 'utf8');
let n = 0;
function rep(from, to) {
  if (!s.includes(from)) { console.error('未找到:', JSON.stringify(from.slice(0, 70))); process.exit(1); }
  s = s.split(from).join(to);
  n++;
}

// 1) evaluateFused 加 tdBlendUp 上限守卫
rep('  if (P.tdBlendFrom > 0 && maxExpQuick(lo, hi) < P.tdBlendFrom) return h;',
    '  if (P.tdBlendFrom > 0 && maxExpQuick(lo, hi) < P.tdBlendFrom) return h;\n' +
    '  if (P.tdBlendUp > 0 && maxExpQuick(lo, hi) > P.tdBlendUp) return h;   // 训练未覆盖的高位不用 TD（防外推垃圾）');

// 2) setTdNet 用兄弟校准
rep('  if (TD_NET && !(TD_NET.K > 0)) {\n' +
    '    // 无预存 K/mean（如未训练的零权重）时用随机盘校准兜底\n' +
    '    TD_NET.tdRelWeight = P.tdRelWeight || 0.03;\n' +
    '    TD_NET.calibrate(randomBoardsForCalibration, evaluate, 3000);\n' +
    '  }',
    '  if (TD_NET && !(TD_NET.K > 0)) {\n' +
    '    // 兄弟校准（决策粒度）：随机盘校准的 K 曾偏大导致搜索崩溃（tdscout03）\n' +
    '    TD_NET.tdRelWeight = P.tdRelWeight || 0.01;\n' +
    '    TD_NET.calibrateSibling(randomSiblingGroups, evaluate, 3000);\n' +
    '  }');

// 3) 校准提供器：随机盘 → 兄弟组
rep('// 校准用随机棋盘提供器（与差分测试同款 realistic 分布）\nfunction randomBoardsForCalibration(cb) {',
    '// 校准用随机兄弟组提供器：随机盘 → 合法动作的 afterstate 兄弟\nfunction randomSiblingGroups(cb) {');
rep('    cb(lo >>> 0, hi >>> 0);\n  }\n}',
    '    // 兄弟组\n    const loArr = [], hiArr = [];\n' +
    '    for (let a = 0; a < 4; a++) {\n' +
    '      const m = moveBoardCal(lo >>> 0, hi >>> 0, a);\n' +
    '      if (m.moved) { loArr.push(m.lo); hiArr.push(m.hi); }\n' +
    '    }\n' +
    '    if (loArr.length >= 2) cb(loArr, hiArr);\n' +
    '  }\n' +
    '}\n' +
    '\n' +
    '// 轻量 moveBoard（兄弟生成用；与引擎主 LUT 独立）\n' +
    'const CAL_MOVE = new Uint16Array(65536), CAL_RIGHT = new Uint16Array(65536);\n' +
    '(function buildCalLuts() {\n' +
    '  function slide(row) {\n' +
    '    const c0=(row>>12)&0xF,c1=(row>>8)&0xF,c2=(row>>4)&0xF,c3=row&0xF;\n' +
    '    const t=[]; if(c0)t.push(c0); if(c1)t.push(c1); if(c2)t.push(c2); if(c3)t.push(c3);\n' +
    '    const out=[];\n' +
    '    for(let i=0;i<t.length;i++){ if(i+1<t.length&&t[i]===t[i+1]){out.push(t[i]+1);i++;} else out.push(t[i]); }\n' +
    '    while(out.length<4)out.push(0);\n' +
    '    return (out[0]<<12)|(out[1]<<8)|(out[2]<<4)|out[3];\n' +
    '  }\n' +
    '  const rv = r => ((r&0xF)<<12)|((r&0xF0)<<4)|((r&0xF00)>>4)|((r&0xF000)>>12);\n' +
    '  for(let r=0;r<65536;r++)CAL_MOVE[r]=slide(r);\n' +
    '  for(let r=0;r<65536;r++)CAL_RIGHT[r]=rv(CAL_MOVE[rv(r)]);\n' +
    '})();\n' +
    'function moveBoardCal(lo, hi, dir) {\n' +
    '  let nlo = 0, nhi = 0, moved = false;\n' +
    '  if (dir === 0 || dir === 1) {\n' +
    '    for (let r = 0; r < 4; r++) {\n' +
    '      const row = r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;\n' +
    '      const nrow = dir === 0 ? CAL_MOVE[row] : CAL_RIGHT[row];\n' +
    '      if (nrow !== row) moved = true;\n' +
    '      if (r < 2) nlo |= nrow << (16 * r); else nhi |= nrow << (16 * (r - 2));\n' +
    '    }\n' +
    '  } else {\n' +
    '    for (let c = 0; c < 4; c++) {\n' +
    '      const sh = 12 - 4 * c;\n' +
    '      const col = (((lo >>> sh) & 0xF) << 12) | (((lo >>> (16 + sh)) & 0xF) << 8)\n' +
    '                | (((hi >>> sh) & 0xF) << 4)  | ((hi >>> (16 + sh)) & 0xF);\n' +
    '      const ncol = dir === 2 ? CAL_MOVE[col] : CAL_RIGHT[col];\n' +
    '      if (ncol !== col) moved = true;\n' +
    '      nlo |= ((ncol >>> 12) & 0xF) << sh;\n' +
    '      nlo |= ((ncol >>> 8) & 0xF) << (16 + sh);\n' +
    '      nhi |= ((ncol >>> 4) & 0xF) << sh;\n' +
    '      nhi |= (ncol & 0xF) << (16 + sh);\n' +
    '    }\n' +
    '  }\n' +
    '  return { lo: nlo >>> 0, hi: nhi >>> 0, moved };\n' +
    '}');

// 4) 参数：tdRelWeight 默认 0.01 + tdBlendUp
rep("  tdRelWeight: 0.03   // K = tdRelWeight × std(V_hand)/std(V_td)\n};",
    "  tdRelWeight: 0.01,  // K = tdRelWeight × std(V_hand兄弟)/std(V_td兄弟)\n  tdBlendUp: 12       // maxExp > 该值时不融合（TD 训练未覆盖的高位防外推垃圾）\n};");

fs.writeFileSync('experiments/_mk_td.js', s);
console.log('已更新 _mk_td.js，替换数', n);
