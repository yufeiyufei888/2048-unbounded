// 为「观战」构建：把 2048.html 复制为带自动演示的 2048-play.html
// 自动演示脚本会在 iframe 内真实按键，肉眼可见地玩
// 注：2026-09-15 交接后路径已从源项目改为本工作空间
const fs = require('fs');
const path = 'C:/Users/yufei/WorkBuddy/2048/';

let html = fs.readFileSync(path + '2048.html', 'utf8');

// 1) 在 </body> 前注入观战控制条 + AI 驱动脚本
const spectatorUI = `
<div id="spectator" style="
  position: fixed; left: 12px; bottom: 12px; z-index: 999;
  background: rgba(119,110,101,.94); color: #f9f6f2; border-radius: 10px;
  padding: 10px 14px; font: 13px/1.5 'Helvetica Neue',Arial,'PingFang SC',sans-serif;
  box-shadow: 0 4px 18px rgba(0,0,0,.25); max-width: 260px; backdrop-filter: blur(4px);">
  <div style="font-weight:800;font-size:14px;margin-bottom:4px">🤖 AI 观战 · 无上限合成</div>
  <div>步数：<b id="sp-moves">0</b> · 最大块：<b id="sp-max">2</b></div>
  <div>本局分：<b id="sp-score">0</b> · 历史最高：<b id="sp-best">0</b></div>
  <div>进度：<b id="sp-prog">思考中…</b></div>
  <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
    <button id="sp-speed" style="flex:1;border:0;border-radius:6px;padding:6px 8px;background:#8f7a66;color:#fff;font-weight:700;cursor:pointer;font-family:inherit">速度 ×1</button>
    <button id="sp-new" style="flex:1;border:0;border-radius:6px;padding:6px 8px;background:#d8cdc2;color:#776e65;font-weight:700;cursor:pointer;font-family:inherit">重开</button>
  </div>
</div>
<script>
(function(){
  var speeds = [600, 300, 140, 60, 0];   // 每步间隔(ms)，0=最快
  var speedIdx = 1;
  var moves = 0;
  var running = false;
  var maxTile = 2;

  var spMoves = document.getElementById('sp-moves');
  var spMax   = document.getElementById('sp-max');
  var spProg  = document.getElementById('sp-prog');
  var spScore = document.getElementById('sp-score');
  var spBest  = document.getElementById('sp-best');
  var btnSpeed= document.getElementById('sp-speed');
  var btnNew  = document.getElementById('sp-new');

  var allTimeBest = 0;
  try { allTimeBest = parseInt(localStorage.getItem('game2048_best_v1'),10) || 0; } catch(e){}
  if (spBest) spBest.textContent = allTimeBest;
  function curScore(){ var el=document.getElementById('score'); return el ? (parseInt(el.textContent,10)||0) : 0; }

  var DIRKEY = { up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight' };
  var BOARD_KEY = 'game2048_best_v1';

  // ---- 纯逻辑：读棋盘（复用 DOM transform 反推）----
  function readBoard(){
    var layer = document.getElementById('tileLayer');
    var cs = getComputedStyle(document.getElementById('boardWrapper'));
    var gap = parseFloat(cs.getPropertyValue('--gap'))||12;
    var layerW = layer.clientWidth || 400;
    var tileW = (layerW - gap*3)/4, step = tileW + gap;
    var g = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
    var els = document.querySelectorAll('.tile');
    for (var i=0;i<els.length;i++){
      var el = els[i];
      var m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(el.style.transform||'');
      if(!m) continue;
      var c = Math.round(parseFloat(m[1])/step), r = Math.round(parseFloat(m[2])/step);
      if(r>=0&&r<4&&c>=0&&c<4) g[r][c] = +el.dataset.value;
    }
    return g;
  }

  // ---- 逻辑模拟 ----
  function slideLine(line){
    var t=[],i;
    for(i=0;i<line.length;i++) if(line[i]) t.push(line[i]);
    var out=[];
    for(i=0;i<t.length;i++){
      if(t[i]===t[i+1]){ out.push(t[i]*2); i++; } else out.push(t[i]);
    }
    while(out.length<4) out.push(0);
    return out;
  }
  function simulate(b, dir){
    var nb=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], moved=false, r,c;
    if(dir==='left'||dir==='right'){
      for(r=0;r<4;r++){
        var line=b[r].slice();
        if(dir==='right') line.reverse();
        var out=slideLine(line);
        if(dir==='right') out.reverse();
        for(c=0;c<4;c++){ nb[r][c]=out[c]; if(out[c]!==b[r][c]) moved=true; }
      }
    } else {
      for(c=0;c<4;c++){
        var col=[b[0][c],b[1][c],b[2][c],b[3][c]];
        if(dir==='down') col.reverse();
        var o2=slideLine(col);
        if(dir==='down') o2.reverse();
        for(r=0;r<4;r++){ nb[r][c]=o2[r]; if(o2[r]!==b[r][c]) moved=true; }
      }
    }
    return { board:nb, moved:moved };
  }
  function emptyCells(b){ var o=[],r,c; for(r=0;r<4;r++) for(c=0;c<4;c++) if(!b[r][c]) o.push([r,c]); return o; }

  // ===== v7 评估函数：指数蛇形权重（与后端 _engine7.js 完全一致）=====
  // 核心洞察：v3 的「指数蛇形权重 4^(15-k)」看起来会让单块占满得分，
  // 但它其实是强结构约束 —— 强制任何时候都不破坏蛇形次序，
  // 评估看不清的细节交给 depth5 深搜去分辨 → 实测均分 3.4 万，已打出 8192。
  // 所以这里直接复刻同一套评估，保证「观战看到的 AI」== 「跑纪录的 AI」。
  var SNAKE_POS = [0,1,2,3, 7,6,5,4, 8,9,10,11, 15,14,13,12];
  var SNAKE_PATH = [];   // 沿蛇形路径的物理格索引
  for (var kk=0; kk<16; kk++) for (var ii=0; ii<16; ii++) if (SNAKE_POS[ii]===kk) { SNAKE_PATH.push(ii); break; }
  function log2(v){ var e=0; while(v>1){ v>>=1; e++; } return e; }

  // 蛇形权重：第 k 位 = 4^(15-k)
  var SW = [];
  for (var kk2=0; kk2<16; kk2++) SW.push(Math.pow(4.5, 15-kk2));
  var POW2 = [];  for (var p2=0; p2<24; p2++) POW2.push(Math.pow(2, p2));
  var EV = { wEmpty:60000, wMono:3.0, wSmooth:6.0, dEmpty1:400000, dEmpty2:60000 };

  function evaluate(b){
    var s=0, empty=0, r, c, k;
    var e = [];
    for(r=0;r<4;r++){ e.push([]); for(c=0;c<4;c++) e[r].push(b[r][c] ? log2(b[r][c]) : 0); }
    // 1) 蛇形权重（主项）
    for(r=0;r<4;r++) for(c=0;c<4;c++){
      var v = e[r][c];
      if(v===0){ empty++; continue; }
      s += POW2[v] * SW[SNAKE_POS[r*4+c]];
    }
    // 2) 空格奖励
    s += empty * EV.wEmpty;
    // 3) 单调性（行 + 列）
    var mono=0, inc, dec, d;
    for(r=0;r<4;r++){ inc=0; dec=0; for(c=0;c<3;c++){ var a=e[r][c], bb=e[r][c+1]; if(a&&bb){ d=Math.abs(POW2[a]-POW2[bb]); if(bb>a) dec+=d; else inc+=d; } } mono += inc>dec?inc:dec; }
    for(c=0;c<4;c++){ inc=0; dec=0; for(r=0;r<3;r++){ var a2=e[r][c], b2=e[r+1][c]; if(a2&&b2){ d=Math.abs(POW2[a2]-POW2[b2]); if(b2>a2) dec+=d; else inc+=d; } } mono += inc>dec?inc:dec; }
    s += mono * EV.wMono;
    // 4) 平滑度惩罚（数值差）
    var smooth=0;
    for(r=0;r<4;r++) for(c=0;c<3;c++){ var a3=e[r][c], b3=e[r][c+1]; if(a3&&b3) smooth+=Math.abs(POW2[a3]-POW2[b3]); }
    for(c=0;c<4;c++) for(r=0;r<3;r++){ var a4=e[r][c], b4=e[r+1][c]; if(a4&&b4) smooth+=Math.abs(POW2[a4]-POW2[b4]); }
    s -= smooth * EV.wSmooth;
    // 5) 危险惩罚
    if(empty<=1) s -= EV.dEmpty1; else if(empty===2) s -= EV.dEmpty2;
    return s;
  }
  function expectimax(b, depth, player){
    if(depth===0) return evaluate(b);
    var r,c,i,j,d;
    if(player){
      var best=-Infinity;
      var ds=['up','down','left','right'];
      for(i=0;i<4;i++){
        var res=simulate(b, ds[i]);
        if(!res.moved) continue;
        var v=expectimax(res.board, depth-1, false);
        if(v>best) best=v;
      }
      if(best===-Infinity) return evaluate(b)-1e9;
      return best;
    } else {
      var cells=emptyCells(b);
      if(!cells.length) return expectimax(b, depth-1, true);
      var cap = depth>=5 ? 6 : 10;
      var n = Math.min(cells.length, cap);
      var sum=0;
      for(i=0;i<n;i++){
        var cc2=cells[Math.floor(Math.random()*cells.length)];
        var rr=cc2[0], ccol=cc2[1];
        for(j=0;j<2;j++){
          var val = j===0?2:4, p = j===0?0.9:0.1;
          var nb=b.map(function(row){return row.slice();});
          nb[rr][ccol]=val;
          sum += p*expectimax(nb, depth-1, true);
        }
      }
      return sum/n;
    }
  }
  function bestMove(b, depth){
    var ds=['up','down','left','right'], best=-Infinity, pick=[], i;
    var order=[2,0,3,1];   // left,up,right,down 优先
    for(i=0;i<4;i++){
      var di=order[i];
      var res=simulate(b, ds[di]);
      if(!res.moved) continue;
      var v=expectimax(res.board, depth-1, false);
      if(v>best+1e-7){ best=v; pick=[ds[di]]; }
      else if(Math.abs(v-best)<1e-7) pick.push(ds[di]);
    }
    if(!pick.length) return null;
    return pick[Math.floor(Math.random()*pick.length)];
  }

  function press(key){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:key,bubbles:true,cancelable:true}));
  }

  function gameOver(){ return document.getElementById('overlay').classList.contains('show'); }

  function tick(){
    if(!running) return;
    if(gameOver()){
      var title=document.getElementById('overlayTitle').textContent;
      spProg.textContent = /赢了/.test(title) ? '🎉 达成 2048！' : '游戏结束';
      running=false;
      return;
    }
    var b=readBoard();
    var mt=Math.max.apply(null,b[0].concat(b[1],b[2],b[3]));
    maxTile=Math.max(maxTile,mt);
    spMax.textContent=maxTile;
    var sc=curScore();
    if (spScore) spScore.textContent=sc;
    if (sc>allTimeBest){ allTimeBest=sc; if (spBest) spBest.textContent=sc; }

    // 自适应深度（与后端 _engine7.js 的 playGame 一致）：空格 <=3 时加深一层
    var emptyCnt=0, rr2, cc2;
    for(rr2=0;rr2<4;rr2++) for(cc2=0;cc2<4;cc2++) if(!b[rr2][cc2]) emptyCnt++;
    var dep = 5 + (emptyCnt<=3 ? 1 : 0);
    var mv=bestMove(b,dep);
    if(!mv){
      spProg.textContent='无步可走';
      running=false;
      return;
    }
    press(DIRKEY[mv]);
    moves++;
    spMoves.textContent=moves;
    spProg.textContent = '第 '+moves+' 步 → ' + ({up:'↑',down:'↓',left:'←',right:'→'})[mv];

    var delay = speeds[speedIdx];
    if(delay===0){ setTimeout(tick, 0); }
    else { setTimeout(tick, delay); }
  }

  btnSpeed.addEventListener('click',function(){
    speedIdx=(speedIdx+1)%speeds.length;
    btnSpeed.textContent = speeds[speedIdx]===0 ? '速度 最快' : '速度 ×'+(speedIdx+1);
  });
  btnNew.addEventListener('click',function(){
    moves=0; maxTile=2; spMoves.textContent='0'; spMax.textContent='2';
    document.getElementById('restart').click();
    if(!running){ running=true; setTimeout(tick, 250); }
  });

  // 首次等游戏初始化完成后开跑
  window.addEventListener('load', function(){
    setTimeout(function(){
      // 若胜利遮罩弹出会挡住操作，把它收起来以便继续挑战
      running=true;
      tick();
    }, 400);
  });

  // 胜利遮罩出现时自动点“继续游戏”，让 AI 继续冲高分
  var overlay=document.getElementById('overlay');
  new MutationObserver(function(){
    if(overlay.classList.contains('show')){
      var cont=document.getElementById('overlayContinue');
      if(cont && cont.style.display!=='none'){ cont.click(); }
    }
  }).observe(overlay,{attributes:true,attributeFilter:['class']});
})();
<\/script>
`;

html = html.replace('</body>', spectatorUI + '</body>');
fs.writeFileSync(path + '2048-play.html', html);
console.log('已生成 2048-play.html，大小', html.length, '字节');
