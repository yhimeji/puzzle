/* ==========================================================================
   パズルバトル（仮） - パズル&ドラゴンズ風 落ちものマッチ3ゲーム
   ・盤面のオーブをドラッグして同色3つ以上をつなげると消せる
   ・消した数に応じて上部の敵にダメージ
   ・敵は一定時間おきに自動攻撃してくる（＝制限時間の代わり）
   ・3ステージ構成
   ========================================================================== */

/* ---------------------------------------------------------
   1. 設定値（ここを変えるだけで難易度や見た目を調整できる）
--------------------------------------------------------- */
const ROWS = 5;
const COLS = 6;
const COLOR_COUNT = 6; // c0〜c5 の6色（c5=ピンク＝回復専用）
const PINK_COLOR = 5;
const LINE_BONUS_DAMAGE = 100; // 横一列・縦一列消しの追加ダメージ

const PLAYER_MAX_HP = 1000;
const HIGH_SCORE_KEY = "puzzleBattleHighScore";

// ステージ定義：敵のHP・攻撃間隔(ms)・1回の攻撃ダメージ・見た目
const STAGES = [
  { name: "スライム", enemyHp: 800, attackInterval: 6000, attackDamage: 70, shape: "slime" },
  { name: "ウルフナイト", enemyHp: 1400, attackInterval: 5000, attackDamage: 100, shape: "wolf" },
  { name: "レッドドラゴン（ボス）", enemyHp: 2200, attackInterval: 4000, attackDamage: 130, shape: "dragon" },
];

// ダメージ計算：3つ消し=100、4つ消し=120、5つ消し=140 …(つながった数-3)*20 を加算
// ※「1.2倍ずつ増える」というご要望と、例示いただいた数値（100/120/140）を突き合わせると
//   100→120は1.2倍だが120→140は1.2倍にはならないため、今回は具体的な数値例（+20ずつ）を採用しています。
//   将来的に「常に前段の1.2倍」にしたい場合は BASE_DAMAGE_FN を変更するだけで良いように分離しています。
function calcBaseDamage(matchCount) {
  return 100 + (matchCount - 3) * 20;
}

// ピンク消し時の回復量：3つ消し=50、4つ消し=60、5つ消し=70…(つながった数-3)*10 を加算
function calcHealAmount(matchCount) {
  return 50 + (matchCount - 3) * 10;
}

// ボールの消し方による今後の拡張ポイント：
// 「十字（プラス）形」に消すとダメージ2倍、というルールを実装済み。
// 今後さらに形状ボーナスを増やしたい場合は、この BONUS_RULES に条件と倍率を追加していく想定。
const BONUS_RULES = [
  { name: "十字消し", test: isCrossShape, multiplier: 2 },
];

/* ---------------------------------------------------------
   2. 状態管理
--------------------------------------------------------- */
const state = {
  values: [],          // 盤面。長さ ROWS*COLS の配列。各要素は 0〜COLOR_COUNT-1 または null
  stageIndex: 0,
  playerHp: PLAYER_MAX_HP,
  enemyHp: 0,
  enemyMaxHp: 0,
  inputEnabled: false,
  score: 0,
};

let dragging = false;
let dragIndex = null;
let activePointerId = null;
let attackTimerId = null;
let orbEls = [];
let ghostEl = null;
let grabbedColor = null;

/* ---------------------------------------------------------
   3. DOM参照
--------------------------------------------------------- */
const boardEl = document.getElementById("board");
const popupLayerEl = document.getElementById("popup-layer");
const enemyNameEl = document.getElementById("enemy-name");
const enemySpriteEl = document.getElementById("enemy-sprite");
const enemyHpBarEl = document.getElementById("enemy-hpbar");
const enemyHpTextEl = document.getElementById("enemy-hp-text");
const playerHpBarEl = document.getElementById("player-hpbar");
const playerHpTextEl = document.getElementById("player-hp-text");
const playerAreaEl = document.getElementById("player-area");
const stageLabelEl = document.getElementById("stage-label");
const enemyAreaEl = document.getElementById("enemy-area");
const clearTitleEl = document.getElementById("clear-title");

/* ---------------------------------------------------------
   4. 便利関数
--------------------------------------------------------- */
function idx(r, c) { return r * COLS + c; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randColor() { return Math.floor(Math.random() * COLOR_COUNT); }

/* ---------------------------------------------------------
   5. 盤面生成（開始直後に3つ揃いができないようにする）
--------------------------------------------------------- */
function generateBoard() {
  const arr = new Array(ROWS * COLS).fill(0);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let color;
      let tries = 0;
      do {
        color = randColor();
        tries++;
      } while (
        tries < 30 &&
        ((c >= 2 && arr[idx(r, c - 1)] === color && arr[idx(r, c - 2)] === color) ||
          (r >= 2 && arr[idx(r - 1, c)] === color && arr[idx(r - 2, c)] === color))
      );
      arr[idx(r, c)] = color;
    }
  }
  return arr;
}

/* ---------------------------------------------------------
   6. マッチ判定（上下左右につながった同色を1グループとして検出）
--------------------------------------------------------- */
function findMatchGroups(values) {
  const visited = new Array(values.length).fill(false);
  const groups = [];

  for (let i = 0; i < values.length; i++) {
    if (visited[i] || values[i] === null) continue;
    const color = values[i];
    const stack = [i];
    visited[i] = true;
    const group = [];

    while (stack.length) {
      const cur = stack.pop();
      group.push(cur);
      const r = Math.floor(cur / COLS);
      const c = cur % COLS;
      const neighbors = [];
      if (r > 0) neighbors.push(cur - COLS);
      if (r < ROWS - 1) neighbors.push(cur + COLS);
      if (c > 0) neighbors.push(cur - 1);
      if (c < COLS - 1) neighbors.push(cur + 1);

      for (const n of neighbors) {
        if (!visited[n] && values[n] === color) {
          visited[n] = true;
          stack.push(n);
        }
      }
    }

    if (group.length >= 3) groups.push(group);
  }

  return groups;
}

// 「十字（プラス）形」判定：グループが5マスで、その中心が上下左右すべて含んでいればOK
function isCrossShape(group) {
  if (group.length !== 5) return false;
  const set = new Set(group);
  for (const cell of group) {
    const r = Math.floor(cell / COLS);
    const c = cell % COLS;
    if (r <= 0 || r >= ROWS - 1 || c <= 0 || c >= COLS - 1) continue;
    const up = cell - COLS, down = cell + COLS, left = cell - 1, right = cell + 1;
    if (set.has(up) && set.has(down) && set.has(left) && set.has(right)) {
      return true;
    }
  }
  return false;
}

// 「横一列」判定：グループの数がCOLSと一致し、全マスが同じ行に収まっていればOK
function isFullRowShape(group) {
  if (group.length !== COLS) return false;
  const r = Math.floor(group[0] / COLS);
  return group.every((cell) => Math.floor(cell / COLS) === r);
}

// 「縦一列」判定：グループの数がROWSと一致し、全マスが同じ列に収まっていればOK
function isFullColumnShape(group) {
  if (group.length !== ROWS) return false;
  const c = group[0] % COLS;
  return group.every((cell) => cell % COLS === c);
}

// マッチグループ1つぶんを「ダメージ」か「回復」かに分類し、量と見た目の種別を返す。
// ・ピンクは回復のみ（ダメージは発生しない）
// ・横一列／縦一列はダメージ+100（十字ボーナスとは別枠・加算方式）
// ・十字は従来通り2倍（乗算方式）
function classifyGroup(group, color) {
  if (color === PINK_COLOR) {
    return { kind: "heal", amount: calcHealAmount(group.length), shape: "normal" };
  }

  let dmg = calcBaseDamage(group.length);
  let shape = "normal";

  if (isFullRowShape(group)) {
    dmg += LINE_BONUS_DAMAGE;
    shape = "lineH";
  } else if (isFullColumnShape(group)) {
    dmg += LINE_BONUS_DAMAGE;
    shape = "lineV";
  } else {
    for (const rule of BONUS_RULES) {
      if (rule.test(group)) dmg *= rule.multiplier;
    }
  }

  return { kind: "damage", amount: dmg, shape };
}

/* ---------------------------------------------------------
   7. 重力落下＆補充
   ・生き残ったオーブが「元々何行目にいたか」を記録し、新しい位置との
     行数の差 = 落下距離 として fallMap に残す。
   ・新しく補充されるオーブは盤面の上（画面外）から落ちてきたことにして、
     落下距離 = missing - r （上にあるものほど長く落ちる）とする。
   ・実際の値の更新はここでは行わず、呼び出し側が state.values に反映し、
     fallMap を使ってアニメーションさせる。
--------------------------------------------------------- */
function computeGravityAndFallMap(values) {
  const newValues = values.slice();
  const fallMap = new Array(values.length).fill(0);

  for (let c = 0; c < COLS; c++) {
    const survivors = [];
    for (let r = 0; r < ROWS; r++) {
      const v = values[idx(r, c)];
      if (v !== null) survivors.push({ value: v, origRow: r });
    }
    const missing = ROWS - survivors.length;

    for (let k = 0; k < survivors.length; k++) {
      const newRow = missing + k;
      newValues[idx(newRow, c)] = survivors[k].value;
      const dist = newRow - survivors[k].origRow;
      if (dist > 0) fallMap[idx(newRow, c)] = dist;
    }
    for (let r = 0; r < missing; r++) {
      newValues[idx(r, c)] = randColor();
      fallMap[idx(r, c)] = missing - r;
    }
  }

  return { newValues, fallMap };
}

// fallMap に従って、対象のオーブを「元の高さ」から現在位置へ一気に落とすアニメーション
function animateFall(fallMap) {
  const cellHeight = boardEl.getBoundingClientRect().height / ROWS;

  orbEls.forEach((orbEl, i) => {
    const dist = fallMap[i] || 0;
    if (dist > 0) {
      orbEl.style.transition = "none";
      orbEl.style.transform = `translateY(${-dist * cellHeight}px)`;
    }
  });

  void boardEl.offsetHeight; // 強制リフローで開始位置を確定させる

  orbEls.forEach((orbEl, i) => {
    const dist = fallMap[i] || 0;
    if (dist > 0) {
      orbEl.style.transition = "transform 260ms cubic-bezier(.25,.85,.3,1.15)";
      orbEl.style.transform = "translateY(0)";
      orbEl.addEventListener("transitionend", function handler() {
        orbEl.style.transition = "";
        orbEl.style.transform = "";
        orbEl.removeEventListener("transitionend", handler);
      });
    }
  });
}

/* ---------------------------------------------------------
   8. 盤面の描画
--------------------------------------------------------- */
function buildBoardDom() {
  boardEl.innerHTML = "";
  orbEls = [];
  for (let i = 0; i < ROWS * COLS; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    const orb = document.createElement("div");
    orb.className = "orb";
    cell.appendChild(orb);
    boardEl.appendChild(cell);
    orbEls.push(orb);
  }
}

function render() {
  for (let i = 0; i < state.values.length; i++) {
    const orb = orbEls[i];
    const v = state.values[i];
    orb.className = "orb";
    if (v === null) {
      orb.classList.add("empty");
    } else {
      orb.classList.add("c" + v);
    }
    // つかんでいるオーブは実体を消し、代わりに ghost 要素が追従する
    if (dragging && i === dragIndex) orb.classList.add("dragging-hidden");
  }
}

/* ---------------------------------------------------------
   9. ドラッグ操作（マウス／タッチ両対応の Pointer Events）
   ・つかんだオーブは指/マウスカーソルにそのまま追従する「ghost」要素として
     表示し、盤面上をなぞった軌跡に沿って本物のドラッグ&ドロップに近い
     見た目にする。
   ・裏側のロジックは元のパズドラ風のまま：セルの境界をまたいだ瞬間に
     data配列を入れ替え、そのマスにあった別の色は即座に元の位置へ移る。
--------------------------------------------------------- */
function getCellIndexFromEvent(e) {
  const rect = boardEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const colW = rect.width / COLS;
  const rowH = rect.height / ROWS;
  let c = Math.floor(x / colW);
  let r = Math.floor(y / rowH);
  c = Math.max(0, Math.min(COLS - 1, c));
  r = Math.max(0, Math.min(ROWS - 1, r));
  return idx(r, c);
}

function createGhost(startIndex, e) {
  const srcRect = orbEls[startIndex].getBoundingClientRect();
  ghostEl = document.createElement("div");
  ghostEl.className = "orb orb-ghost c" + grabbedColor;
  ghostEl.style.width = srcRect.width + "px";
  ghostEl.style.height = srcRect.height + "px";
  ghostEl.style.boxShadow =
    "inset 0 -6px 8px rgba(0,0,0,.35), inset 0 4px 6px rgba(255,255,255,.35), 0 10px 20px rgba(0,0,0,.55), 0 0 0 3px rgba(255,255,255,.85)";
  boardEl.appendChild(ghostEl);
  positionGhost(e);
}

function positionGhost(e) {
  if (!ghostEl) return;
  const rect = boardEl.getBoundingClientRect();
  const size = ghostEl.offsetWidth;
  const x = e.clientX - rect.left - size / 2;
  const y = e.clientY - rect.top - size / 2;
  ghostEl.style.transform = `translate(${x}px, ${y}px) scale(1.12)`;
}

function removeGhost() {
  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }
}

function onPointerDown(e) {
  if (!state.inputEnabled) return;
  e.preventDefault();
  dragging = true;
  dragIndex = getCellIndexFromEvent(e);
  grabbedColor = state.values[dragIndex];
  activePointerId = e.pointerId;
  try { boardEl.setPointerCapture(activePointerId); } catch (err) { /* noop */ }
  createGhost(dragIndex, e);
  render();
}

function onPointerMove(e) {
  if (!dragging) return;
  e.preventDefault();
  positionGhost(e);
  const index = getCellIndexFromEvent(e);
  if (index !== dragIndex) {
    const tmp = state.values[dragIndex];
    state.values[dragIndex] = state.values[index];
    state.values[index] = tmp;
    dragIndex = index;
    render();
  }
}

function onPointerUp(e) {
  if (!dragging) return;
  dragging = false;
  try { boardEl.releasePointerCapture(activePointerId); } catch (err) { /* noop */ }
  removeGhost();
  dragIndex = null;
  grabbedColor = null;
  render();
  resolveMatches();
}

boardEl.addEventListener("pointerdown", onPointerDown);
boardEl.addEventListener("pointermove", onPointerMove);
boardEl.addEventListener("pointerup", onPointerUp);
boardEl.addEventListener("pointercancel", onPointerUp);

/* ---------------------------------------------------------
   10. マッチ解決（消去 → 落下 → 連鎖判定をループ）
--------------------------------------------------------- */
async function resolveMatches() {
  state.inputEnabled = false;
  let totalDamage = 0;
  let totalHeal = 0;
  let cascade = 0;

  while (true) {
    const groups = findMatchGroups(state.values);
    if (groups.length === 0) break;
    cascade++;

    const clearedIdx = [];
    const shapeByIdx = new Map();
    for (const g of groups) {
      const color = state.values[g[0]];
      const result = classifyGroup(g, color);
      if (result.kind === "heal") {
        totalHeal += result.amount;
      } else {
        totalDamage += result.amount;
      }
      for (const cell of g) shapeByIdx.set(cell, result.shape);
      clearedIdx.push(...g);
    }

    clearedIdx.forEach((i) => {
      orbEls[i].classList.add("clearing");
      const shape = shapeByIdx.get(i);
      if (shape === "lineH") orbEls[i].classList.add("clearing-line-h");
      if (shape === "lineV") orbEls[i].classList.add("clearing-line-v");
    });
    if (cascade >= 2) showCombo(cascade);
    await sleep(380);

    clearedIdx.forEach((i) => { state.values[i] = null; });
    const { newValues, fallMap } = computeGravityAndFallMap(state.values);
    state.values = newValues;
    render();
    animateFall(fallMap);
    await sleep(280);
  }

  if (totalDamage > 0) {
    dealDamageToEnemy(totalDamage, cascade);
  }
  if (totalHeal > 0) {
    healPlayer(totalHeal);
  }

  if (state.enemyHp > 0 && state.playerHp > 0) {
    state.inputEnabled = true;
  }
}

/* ---------------------------------------------------------
   11. ダメージ・攻撃処理
--------------------------------------------------------- */
function showPopup(target, text, cls) {
  const span = document.createElement("span");
  span.className = "dmg-pop " + cls;
  span.textContent = text;
  span.style.left = (40 + Math.random() * 20) + "%";
  popupLayerEl.appendChild(span);
  setTimeout(() => span.remove(), 1000);
}

// 2連鎖以上のときに盤面の中央に「2combo」のように表示する
function showCombo(cascadeCount) {
  const el = document.createElement("div");
  el.className = "combo-pop";
  el.textContent = cascadeCount + "combo";
  boardEl.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

function triggerShake(el) {
  el.classList.remove("shake");
  // 強制再描画してから付け直すことで連続発生時も再アニメーションさせる
  void el.offsetWidth;
  el.classList.add("shake");
}

function updateHpBars() {
  const enemyPct = state.enemyMaxHp > 0 ? Math.max(0, state.enemyHp / state.enemyMaxHp * 100) : 0;
  enemyHpBarEl.style.width = enemyPct + "%";
  enemyHpTextEl.textContent = Math.max(0, state.enemyHp) + " / " + state.enemyMaxHp;

  const playerPct = Math.max(0, state.playerHp / PLAYER_MAX_HP * 100);
  playerHpBarEl.style.width = playerPct + "%";
  playerHpBarEl.classList.toggle("low", playerPct <= 25);
  playerHpTextEl.textContent = Math.max(0, state.playerHp) + " / " + PLAYER_MAX_HP;
}

function dealDamageToEnemy(amount, cascade) {
  state.enemyHp = Math.max(0, state.enemyHp - amount);
  state.score += amount;
  updateHpBars();
  const label = cascade > 1 ? `-${amount}（${cascade}連鎖）` : `-${amount}`;
  showPopup("enemy", label, "enemy");
  triggerShake(enemySpriteEl);
  if (state.enemyHp <= 0) onEnemyDefeated();
}

function healPlayer(amount) {
  state.playerHp = Math.min(PLAYER_MAX_HP, state.playerHp + amount);
  updateHpBars();
  showPopup("player", "+" + amount, "heal");
}

function enemyAttack() {
  const stage = STAGES[state.stageIndex];
  state.playerHp = Math.max(0, state.playerHp - stage.attackDamage);
  updateHpBars();
  showPopup("player", "-" + stage.attackDamage, "player");
  triggerShake(playerAreaEl);
  if (state.playerHp <= 0) onPlayerDefeated();
}

function startEnemyAttackTimer() {
  clearAttackTimer();
  const stage = STAGES[state.stageIndex];
  attackTimerId = setInterval(() => {
    if (state.playerHp <= 0 || state.enemyHp <= 0) return;
    enemyAttack();
  }, stage.attackInterval);
}

function clearAttackTimer() {
  if (attackTimerId) {
    clearInterval(attackTimerId);
    attackTimerId = null;
  }
}

/* ---------------------------------------------------------
   12. 勝敗・ステージ進行
--------------------------------------------------------- */
// その時点のスコア = 与えた総ダメージ + 残りプレイヤー体力ボーナス
function computeCurrentScore() {
  return state.score + state.playerHp;
}

function showScoreResult(prefix, score) {
  const stored = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0);
  const isNewRecord = score > stored;
  const highScore = isNewRecord ? score : stored;
  if (isNewRecord) localStorage.setItem(HIGH_SCORE_KEY, String(score));

  document.getElementById(prefix + "-score").textContent = score;
  document.getElementById(prefix + "-highscore").textContent = highScore;
  document.getElementById(prefix + "-newrecord").classList.toggle("hidden", !isNewRecord);
}

function onEnemyDefeated() {
  clearAttackTimer();
  state.inputEnabled = false;
  setTimeout(() => {
    const score = computeCurrentScore();
    if (state.stageIndex + 1 < STAGES.length) {
      clearTitleEl.textContent = STAGES[state.stageIndex].name + " を倒した！";
      showScoreResult("clear", score);
      showScreen("clear");
    } else {
      showScoreResult("win", score);
      showScreen("win");
    }
  }, 500);
}

function onPlayerDefeated() {
  clearAttackTimer();
  state.inputEnabled = false;
  setTimeout(() => showScreen("over"), 300);
}

function updateEnemyUI(stage) {
  enemyNameEl.textContent = "ステージ " + (state.stageIndex + 1) + " ／ " + stage.name;
  enemySpriteEl.className = "enemy-sprite " + stage.shape;
  stageLabelEl.textContent = "ステージ " + (state.stageIndex + 1) + " / " + STAGES.length;
  enemyAreaEl.className = "bg-stage-" + state.stageIndex;
}

function startStage(index) {
  state.stageIndex = index;
  const stage = STAGES[index];
  state.enemyHp = stage.enemyHp;
  state.enemyMaxHp = stage.enemyHp;
  if (index === 0) {
    state.playerHp = PLAYER_MAX_HP; // 新しい挑戦は満タンから
    state.score = 0;
  }
  state.values = generateBoard();
  state.inputEnabled = true;

  render();
  updateHpBars();
  updateEnemyUI(stage);
  showScreen("battle");
  startEnemyAttackTimer();
}

/* ---------------------------------------------------------
   13. 画面切り替え
--------------------------------------------------------- */
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
}

/* ---------------------------------------------------------
   14. 初期化
--------------------------------------------------------- */
document.getElementById("btn-start").addEventListener("click", () => startStage(0));
document.getElementById("btn-next").addEventListener("click", () => startStage(state.stageIndex + 1));
document.getElementById("btn-retry").addEventListener("click", () => startStage(0));
document.getElementById("btn-title").addEventListener("click", () => showScreen("title"));
document.getElementById("btn-again").addEventListener("click", () => startStage(0));

buildBoardDom();
