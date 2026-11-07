'use strict';
/* 登販ミニ模試
 * - 問題文は持たない。利用者が取り込んだ公式PDFから該当部分を描画する
 * - meta.json: 試験ごとの PDF の SHA-256、問題ごとの章・正答・ページ上の位置
 * - 記録はこの端末の IndexedDB に保存（バックアップの書き出し・読み込みあり）
 */

const CH_NAMES = {
  1: '医薬品に共通する特性と基本的な知識',
  2: '人体の働きと医薬品',
  3: '主な医薬品とその作用',
  4: '薬事関係法規・制度',
  5: '医薬品の適正使用・安全対策',
};
const CH_SHORT = { 1: '1 共通特性', 2: '2 人体', 3: '3 主な医薬品', 4: '4 法規', 5: '5 適正使用' };
const PLAN = { 1: 2, 2: 2, 3: 4, 4: 2, 5: 2 };   // 本番の1/10
const TIME_LIMIT = 24 * 60;                        // 秒
const DEFAULT_SETTINGS = { pWrong: 0.35, pRight: 0.10, recentDays: 3 };

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PDF_OPTS = {
  // cdnjs は cmaps / standard_fonts を配信していない（403）ため jsDelivr を使う
  cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
};

/* ---------- 小物 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtTime = (s) => `${Math.floor(s / 60)}:${pad2(s % 60)}`;
function toast(msg, ms = 2500) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), ms);
}
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { } }

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('touhan-mini', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('files', { keyPath: 'sha' });
        db.createObjectStore('tests', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('qstats', { keyPath: 'qid' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  get(store, key) { return this.tx(store, 'readonly', (s) => s.get(key)); },
  all(store) { return this.tx(store, 'readonly', (s) => s.getAll()); },
  keys(store) { return this.tx(store, 'readonly', (s) => s.getAllKeys()); },
  put(store, v) { return this.tx(store, 'readwrite', (s) => s.put(v)); },
  clear(store) { return this.tx(store, 'readwrite', (s) => s.clear()); },
};

/* ---------- 状態 ---------- */
let META = null;          // meta.json
let QUESTIONS = [];       // 全問題 {qid, exam, n, ch, a, segs, note}
let HAVE = new Set();     // 取り込み済み PDF の sha256
let QSTATS = new Map();   // qid -> 成績
let TESTS = [];           // 受験記録
let settings = Object.assign({}, DEFAULT_SETTINGS, lsGet('settings', {}));
let timerId = null;
let tab = 'home';

const examOf = (qid) => META.exams.find((e) => e.id === qid.split(':')[0]);
// 章ごとの出題対象年度（令和）。制度改正の影響が大きい章ほど新しい年度に限る
//  第4章（法規）: R7以降 / 第5章（適正使用・安全対策）: R6以降 / 第1〜3章: R4以降
// 2027年春の手引き改訂が公表されたら見直すこと
const MIN_YEAR = { 1: 4, 2: 4, 3: 4, 4: 7, 5: 6 };
// 全員正解とされた問題（不適切問題）は出題しない
const available = (q) => q.a.length < 5 && q.exam.year >= MIN_YEAR[q.ch] && HAVE.has(q.exam.files[q.segs[0].f].sha256);

async function loadAll() {
  META = await (await fetch('meta.json', { cache: 'no-cache' })).json();
  QUESTIONS = [];
  for (const e of META.exams) for (const q of e.q) QUESTIONS.push({ ...q, qid: `${e.id}:${q.n}`, exam: e });
  HAVE = new Set(await DB.keys('files'));
  QSTATS = new Map((await DB.all('qstats')).map((s) => [s.qid, s]));
  TESTS = (await DB.all('tests')).sort((a, b) => a.startedAt - b.startedAt);
}

/* ---------- 出題 ---------- */
function weightedPick(arr, wfn) {
  const ws = arr.map(wfn); const sum = ws.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}
const recencyW = (q) => 1 + Math.max(0, q.exam.year - 4) * 0.75;  // 新しい年度ほど出やすく（R8はR4の4倍）
const DAY = 86400000;
const AGAIN_DAYS = 7;   // 「またやりたい」をチェックしてから再出題するまでの日数

function buildTest() {
  const now = Date.now();
  const items = [];
  for (const ch of [1, 2, 3, 4, 5]) {
    const pool = QUESTIONS.filter((q) => q.ch === ch && available(q));
    const unseen = [], wrong = [], right = [], again = [];
    for (const q of pool) {
      const s = QSTATS.get(q.qid);
      if (s && s.again) { // 「またやりたい」: 1週間は出さず、過ぎたら最優先
        if (now - s.againAt >= AGAIN_DAYS * DAY) again.push(q);
        continue;
      }
      if (!s) unseen.push(q);
      else if (!s.lastCorrect) wrong.push(q);
      else if (now - s.lastAt > settings.recentDays * DAY) right.push(q);
    }
    const used = new Set();
    for (let k = 0; k < PLAN[ch]; k++) {
      const due = again.filter((q) => !used.has(q.qid));
      if (due.length) { // 古いチェックから順に
        due.sort((a, b) => QSTATS.get(a.qid).againAt - QSTATS.get(b.qid).againAt);
        used.add(due[0].qid); items.push({ qid: due[0].qid, ch, chosen: null }); continue;
      }
      const r = Math.random();
      const order = r < settings.pWrong ? [wrong, unseen, right]
        : r < settings.pWrong + settings.pRight ? [right, unseen, wrong]
          : [unseen, wrong, right];
      let pick = null;
      for (const group of order) {
        const cand = group.filter((q) => !used.has(q.qid));
        if (!cand.length) continue;
        if (group === unseen) pick = weightedPick(cand, recencyW);
        else if (group === wrong) pick = weightedPick(cand, (q) => (QSTATS.get(q.qid).wrong + 1) * recencyW(q));
        else pick = weightedPick(cand, (q) => Math.min(60, (now - QSTATS.get(q.qid).lastAt) / DAY) * recencyW(q));
        break;
      }
      if (!pick) { // 直近に正解した問題しか残っていない場合
        const cand = pool.filter((q) => !used.has(q.qid));
        if (cand.length) pick = cand[Math.floor(Math.random() * cand.length)];
      }
      if (pick) { used.add(pick.qid); items.push({ qid: pick.qid, ch, chosen: null }); }
    }
  }
  return items;
}

function gradeOf(perCh, score, total) {
  // 本番: 総得点7割以上 かつ 各章35〜40%以上 → ミニ版: 12問中9問以上 かつ 各章で足切りなし
  const cut = Object.entries(perCh).some(([ch, [c, t]]) => t > 0 && c / t < 0.4);
  if (total !== 12) { // 問題が足りない場合は割合で判定
    const r = score / Math.max(1, total);
    return r >= 0.75 && !cut ? 'A' : r >= 0.66 ? 'B' : r >= 0.5 ? 'C' : r >= 0.33 ? 'D' : 'E';
  }
  if (score >= 9 && !cut) return 'A';
  if (score >= 8) return 'B';
  if (score >= 6) return 'C';
  if (score >= 4) return 'D';
  return 'E';
}
const GRADE_TEXT = {
  A: '合格圏（本番なら合格ライン）', B: 'あと一歩', C: 'もう少し', D: '基礎を固めよう', E: 'まずはテキストを1周',
};

/* ---------- PDF 描画 ---------- */
const docCache = new Map();
async function getDoc(sha) {
  if (docCache.has(sha)) return docCache.get(sha);
  const p = (async () => {
    const f = await DB.get('files', sha);
    if (!f) throw new Error('PDFが取り込まれていません');
    const data = new Uint8Array(await f.blob.arrayBuffer());
    return pdfjsLib.getDocument({ data, ...PDF_OPTS }).promise;
  })();
  docCache.set(sha, p);
  return p;
}

let renderToken = 0;
async function renderQuestion(q, box, zoom) {
  const my = ++renderToken;
  box.innerHTML = '<div class="loading">読み込み中…</div>';
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cssW = box.clientWidth * zoom;
  const canvases = [];
  try {
    for (const sg of q.segs) {
      const doc = await getDoc(q.exam.files[sg.f].sha256);
      const page = await doc.getPage(sg.p);
      const base = page.getViewport({ scale: 1 });
      const cropW = (sg.x1 - sg.x0) * base.width, cropH = (sg.y1 - sg.y0) * base.height;
      const scale = (cssW / cropW) * dpr;
      const vp = page.getViewport({ scale, offsetX: -sg.x0 * base.width * scale, offsetY: -sg.y0 * base.height * scale });
      const cv = document.createElement('canvas');
      cv.width = Math.round(cropW * scale); cv.height = Math.round(cropH * scale);
      cv.style.width = `${cssW}px`; cv.style.height = `${(cropH * cssW) / cropW}px`;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      canvases.push(cv);
    }
    if (my !== renderToken) return;
    box.innerHTML = '';
    canvases.forEach((c) => box.appendChild(c));
  } catch (e) {
    if (my === renderToken) box.innerHTML = `<div class="loading">表示できませんでした: ${esc(e.message)}</div>`;
  }
}

/* ---------- テキスト表示 ----------
 * 取り込んだ公式PDFから、この端末の中で文字を取り出して組み直す（どこにも送信・保存しない）。
 * ふりがな（小さい文字）は除き、行→段落にまとめ、正誤の組合せ表は表にする。 */
const textCache = new Map();
const MARK_RE = /^(【?問\s*[0-9０-９]+|[（(]\s*[a-eａ-ｅA-EＡ-Ｅア-オ]\s*[）)]|[a-eａ-ｅA-EＡ-Ｅ][\s　．.、)）]|[ア-オ][\s　．.、)）]|[1-5１-５][\s　．.、（(）)]|[①-⑳]|[・※〔［\[]|\(?[ｱ-ｵ]\))/;
const GRID_RE = /^[\s　0-9０-９a-eａ-ｅア-オ正誤○×]+$/;

async function extractText(q) {
  if (textCache.has(q.qid)) return textCache.get(q.qid);
  const items = [];
  for (const sg of q.segs) {
    const doc = await getDoc(q.exam.files[sg.f].sha256);
    const page = await doc.getPage(sg.p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const top = sg.y0 * vp.height, bottom = sg.y1 * vp.height;
    for (const it of tc.items) {
      const str = (it.str || '').replace(/[\u0000-\u001f\u007f]/g, '');
      if (!str.trim()) continue;
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      if (y - size * 0.7 < top - 2 || y > bottom + 2) continue;
      items.push({ str, x, y: y + sg.p * 10000, size, w: it.width || size * str.length });
    }
  }
  if (!items.length) { textCache.set(q.qid, null); return null; }
  const sizes = items.map((i) => i.size).sort((a, b) => a - b);
  const med = sizes[Math.floor(sizes.length / 2)];
  const body = items.filter((i) => i.size >= med * 0.7);   // ふりがなを除く
  body.sort((a, b) => a.y - b.y || a.x - b.x);
  // 行にまとめる
  const lines = [];
  for (const it of body) {
    const ln = lines[lines.length - 1];
    if (ln && Math.abs(it.y - ln.y) < med * 0.5) ln.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  // 行ごとに、大きな空白でセルに分ける
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    ln.cells = []; let cur = null, end = -1e9;
    for (const it of ln.items) {
      const gap = it.x - end;
      if (!cur || gap > med * 1.5) { cur = { x: it.x, s: '' }; ln.cells.push(cur); }
      else if (gap > med * 0.3 && !/\s$/.test(cur.s)) cur.s += ' ';
      cur.s += it.str; end = it.x + it.w;
    }
    ln.cells.forEach((c) => { c.s = c.s.replace(/\s+/g, ' ').trim(); });
    ln.cells = ln.cells.filter((c) => c.s);
    // 「（　ａ　）は、…」のような空欄のかっこで分かれたセルはつなぎ直す
    for (let k = 0; k < ln.cells.length - 1;) {
      const a = ln.cells[k].s, b = ln.cells[k + 1].s;
      if (/[（(]$/.test(a) || /^[）)]/.test(b) || (/^[（(]/.test(a) && a.length <= 3 && !/[）)]/.test(a))) {
        ln.cells[k].s = `${a} ${b}`; ln.cells.splice(k + 1, 1);
      } else k++;
    }
    ln.text = ln.cells.map((c) => c.s).join(' ');
    ln.x = ln.items[0].x;
  }
  // 1行に選択肢が横並び（「1 ○○  2 ○○  3 ○○」）なら選択肢ごとの行に分ける
  const CH_RE = /^([1-5１-５])[\s　]/;
  const split = [];
  for (const ln of lines) {
    const m = ln.text && ln.text.match(CH_RE);
    if (!m) { split.push(ln); continue; }
    const parts = [];
    let rest = ln.text, n = Number(String(m[1]).replace(/[１-５]/, (c) => '１２３４５'.indexOf(c) + 1));
    for (;;) {
      const nx = n + 1;
      const re = new RegExp(`[\\s　]([${nx}${'１２３４５'[nx - 1] || ''}])[\\s　]`);
      const k = nx <= 5 ? rest.search(re) : -1;
      if (k < 0) { parts.push(rest); break; }
      parts.push(rest.slice(0, k)); rest = rest.slice(k + 1); n = nx;
    }
    if (parts.length === 1) { split.push(ln); continue; }
    parts.forEach((t, k) => split.push({ ...ln, y: ln.y + k * 0.01, text: t.trim(), cells: [{ s: t.trim() }] }));
  }
  lines.splice(0, lines.length, ...split);
  // 段落・表に組み立てる
  const blocks = [];
  let prev = null;
  for (const ln of lines) {
    if (!ln.text) continue;
    const gapY = prev ? ln.y - prev.y : 0;
    const compact = ln.text.replace(/[\s　]/g, '');
    const isGrid = compact.length <= 8 && GRID_RE.test(ln.text) && /[正誤○×]|^[a-eａ-ｅア-オ\s　]+$/.test(ln.text);
    // 3列以上、または「成分名　分量」のような短い2列の行は表として扱う
    const isTable = !isGrid && (ln.cells.length >= 3 || (ln.cells.length === 2 && !MARK_RE.test(ln.text)
      && ln.cells[1].s.length <= 14 && ln.cells[0].s.length <= 30));
    const last = blocks[blocks.length - 1];
    // 空欄「（ ａ ）」で始まる行は、字下げされている場合だけ新しい段落（文の途中の折り返しを除く）
    const blankStart = /^[（(]\s*[a-eａ-ｅA-EＡ-Ｅア-オ]\s*[）)]/.test(ln.text);
    const isMark = MARK_RE.test(ln.text) && !(blankStart && prev && ln.x <= prev.x + med * 0.5);
    if (isGrid || isTable) {
      const row = isGrid ? [...compact] : ln.cells.map((c) => c.s);
      const kind = isGrid ? 'grid' : 'table';
      if (last && last.type === kind && gapY < med * 2.6) last.rows.push(row);
      else if (kind === 'table' && last && last.type === 'grid' && last.rows.length === 1 && /^[a-eａ-ｅア-オ]+$/.test(last.rows[0].join(''))) {
        // 「ａ ｂ ｃ」の見出し行 + 語句の組合せ表 → 1つの表にする
        last.type = 'table'; last.head = true; last.rows.push(row);
      } else blocks.push({ type: kind, rows: [row] });
    } else if (last && last.type === 'p' && !isMark && gapY < med * 1.9) {
      last.text += (/[A-Za-z0-9]$/.test(last.text) && /^[A-Za-z0-9]/.test(ln.text) ? ' ' : '') + ln.text;
    } else {
      blocks.push({ type: 'p', text: ln.text, item: isMark && !/^【?問/.test(ln.text) });
    }
    prev = ln;
  }
  textCache.set(q.qid, blocks);
  return blocks;
}

// 表と表の間に段落が挟まる（＝表のセル内の折り返しが段落に化けた）場合は崩れているとみなす
function isComplexTable(blocks) {
  const kinds = blocks.map((b) => b.type);
  const first = kinds.indexOf('table'), last = kinds.lastIndexOf('table');
  return first >= 0 && last > first && kinds.slice(first, last).includes('p');
}

// AIに解説を頼むための文面（問題文はこの端末でPDFから取り出したもの）
function blocksToPlain(blocks) {
  return blocks.map((b) => (b.type === 'p' ? b.text : b.rows.map((r) => r.join('　')).join('\n'))).join('\n');
}
async function copyForAI(q, it) {
  const blocks = await extractText(q).catch(() => null);
  if (!blocks) { toast('この問題は文字を取り出せないため、コピーできません'); return; }
  const lines = [
    `以下は登録販売者試験の過去問（${q.exam.label} ${q.d}）です。`,
    `正答は「${q.a.join('・')}」です。${it.chosen ? `私は「${it.chosen}」を選びました。` : '私は解答できませんでした。'}`,
    '各選択肢・各記述が正しい理由／誤っている理由を、厚生労働省「登録販売者試験問題の作成に関する手引き」の内容に沿って、初学者にもわかるように解説してください。',
    it.chosen && !it.correct ? '私の選んだ答えがなぜ誤りなのかも教えてください。' : '',
    '覚え方のコツがあれば最後に添えてください。',
    isComplexTable(blocks) ? '（※表を含む問題で、表の部分が崩れている場合があります）' : '',
    '',
    '――― 問題 ―――',
    blocksToPlain(blocks),
  ].filter((l) => l !== '');
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('コピーしました。GeminiなどのAIのチャットに貼り付けてください', 3500);
}

/* ---------- 記述ごとの○×メモ ----------
 * 本番で問題冊子に書き込むのと同じように、各記述に ○ × △ を付けられる。
 * 正誤の組合せ表があれば、付けた印と矛盾する選択肢の行を薄くする（消去法）。 */
const MEMO_CYCLE = ['', '○', '×', '△'];
const memoLabel = (text) => { // 記述の記号（a〜e / ア〜オ / 1〜5）
  const c = text.normalize('NFKC').trim()[0];
  return /[a-eA-E]/.test(c) ? c.toLowerCase() : /[ア-オ1-5]/.test(c) ? c : null;
};
function applyMemo(box, blocks, marks) {
  const byLabel = {};
  blocks.forEach((b, i) => { if (b.type === 'p' && b.item && marks[i]) { const l = memoLabel(b.text); if (l) byLabel[l] = marks[i]; } });
  box.querySelectorAll('table.grid').forEach((tbl) => {
    const b = blocks[+tbl.dataset.bi];
    const head = b.rows[0].map((c) => c.normalize('NFKC').toLowerCase());
    if (!head.every((c) => /[a-eア-オ]/.test(c))) return;
    tbl.querySelectorAll('tr').forEach((tr, ri) => {
      if (ri === 0) return;
      const vals = b.rows[ri].slice(-head.length);
      const ok = head.every((l, k) => !byLabel[l] || byLabel[l] === '△'
        || (byLabel[l] === '○' && vals[k] === '正') || (byLabel[l] === '×' && vals[k] === '誤'));
      tr.classList.toggle('dim', !ok);
    });
  });
}

function blocksToHtml(blocks, marks) {
  return blocks.map((b, bi) => {
    if (b.type === 'p' && b.item && marks) {
      return `<p class="item memo"><button class="mk ${marks[bi] ? 'on' : ''}" data-bi="${bi}" aria-label="メモ">${marks[bi] || ''}</button>${esc(b.text)}</p>`;
    }
    if (b.type === 'p') return `<p class="${b.item ? 'item' : ''}">${esc(b.text)}</p>`;
    const w = Math.max(...b.rows.map((r) => r.length));
    const rows = b.rows.map((r, ri) => {
      const pad = (b.type === 'grid' || (b.head && ri === 0)) ? Array(w - r.length).fill('') : [];   // 見出し行（ａｂｃｄ）は右に寄せる
      const cells = [...pad, ...r, ...(b.type === 'table' && !pad.length ? Array(w - r.length).fill('') : [])];
      return `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="${b.type}" data-bi="${bi}">${rows}</table>`;
  }).join('');
}

const TEXT_SIZES = { 1: 16, 1.5: 19, 2: 23 };
let viewMode = lsGet('viewMode', 'text');   // 'text' | 'pdf'
// memo: { marks: {ブロック番号: '○'|'×'|'△'}, save() } を渡すと○×メモが使える（テスト中のみ）
async function showQuestion(q, box, zoom, memo) {
  if (viewMode === 'pdf') return renderQuestion(q, box, zoom);
  const my = ++renderToken;
  box.innerHTML = '<div class="loading">読み込み中…</div>';
  try {
    const blocks = await extractText(q);
    if (my !== renderToken) return;
    if (!blocks) { // 文字のないページ（画像）
      await renderQuestion(q, box, zoom);
      box.insertAdjacentHTML('afterbegin', '<div class="note" style="padding:6px 8px">この問題は文字を取り出せないため、PDFで表示しています。</div>');
      return;
    }
    if (isComplexTable(blocks)) { // セル内で折り返す表はテキストでは崩れる
      await renderQuestion(q, box, zoom);
      box.insertAdjacentHTML('afterbegin', '<div class="note" style="padding:6px 8px">複雑な表を含むため、PDFで表示しています。</div>');
      return;
    }
    const marks = memo ? memo.marks : null;
    box.innerHTML = `<div class="qtext" style="font-size:${TEXT_SIZES[zoom] || 16}px">${blocksToHtml(blocks, marks)}</div>`;
    if (memo) {
      applyMemo(box, blocks, marks);
      box.querySelectorAll('button.mk').forEach((btn) => btn.addEventListener('click', () => {
        const bi = +btn.dataset.bi;
        const next = MEMO_CYCLE[(MEMO_CYCLE.indexOf(marks[bi] || '') + 1) % MEMO_CYCLE.length];
        if (next) marks[bi] = next; else delete marks[bi];
        btn.textContent = next; btn.classList.toggle('on', !!next);
        applyMemo(box, blocks, marks);
        memo.save();
      }));
    }
  } catch (e) {
    if (my === renderToken) box.innerHTML = `<div class="loading">表示できませんでした: ${esc(e.message)}</div>`;
  }
}
const viewBtnLabel = () => (viewMode === 'text' ? 'PDFで見る' : 'テキストで見る');
const zoomLabel = (z) => `文字：${z === 1 ? '標準' : z === 1.5 ? '大' : '特大'}`;

/* ---------- 画面: ホーム ---------- */
function setTab(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  ({ home: viewHome, calendar: viewCalendar, stats: viewStats, data: viewData })[t]();
  window.scrollTo(0, 0);
}

function viewHome() {
  const pool = QUESTIONS.filter(available);
  const byCh = [1, 2, 3, 4, 5].map((c) => pool.filter((q) => q.ch === c).length);
  const ready = [1, 2, 3, 4, 5].every((c, i) => byCh[i] >= PLAN[c]);
  const seen = pool.filter((q) => QSTATS.has(q.qid)).length;
  const wrongNow = pool.filter((q) => QSTATS.get(q.qid) && !QSTATS.get(q.qid).lastCorrect).length;
  const flagged = pool.filter((q) => QSTATS.get(q.qid)?.again);
  const flaggedDue = flagged.filter((q) => Date.now() - QSTATS.get(q.qid).againAt >= AGAIN_DAYS * DAY).length;
  const recent = TESTS.slice(-5).reverse();
  const resume = lsGet('current', null);
  $('#view').innerHTML = `
    ${resume ? `<div class="card"><h2>受験中のテストがあります</h2>
      <div class="row"><button class="btn pri" id="resume">続ける</button><button class="btn danger" id="discard">破棄する</button></div></div>` : ''}
    <div class="card">
      <h2>ミニ模試（12問・24分）</h2>
      <p class="muted">本番120問・240分を1/10にした構成です。<br>
      第1章2問／第2章2問／第3章4問／第4章2問／第5章2問</p>
      <button class="big-btn" id="start" ${ready ? '' : 'disabled'}>テストを始める</button>
      ${ready ? '' : `<p class="muted">先に「データ」タブで過去問PDFを取り込んでください。</p>`}
    </div>
    <div class="card">
      <h2>進み具合</h2>
      <div class="muted">取り込み済み ${pool.length.toLocaleString()} 問中、解いた問題 ${seen.toLocaleString()} 問 ／ 最後に間違えたまま ${wrongNow} 問</div>
      <div class="progress" style="margin-top:8px"><div style="width:${pool.length ? (seen / pool.length) * 100 : 0}%"></div></div>
      ${flagged.length ? `<div class="muted" style="margin-top:8px">★ またやりたい ${flagged.length} 問（うち出題待ち ${flaggedDue} 問）</div>` : ''}
    </div>
    <div class="card">
      <h2>最近の結果</h2>
      ${recent.length ? `<div class="qlist">${recent.map((t) => `
        <button data-test="${t.id}"><span class="grade ${t.grade}">${t.grade}</span>
        <span>${ymd(t.startedAt)}　${t.score}/${t.items.length}問</span><span class="spacer"></span><span class="muted">${fmtTime(t.durationSec)}</span></button>`).join('')}</div>`
      : '<p class="muted">まだ記録がありません。</p>'}
    </div>`;
  $('#start')?.addEventListener('click', startTest);
  $('#resume')?.addEventListener('click', () => runTest(lsGet('current', null)));
  $('#discard')?.addEventListener('click', () => { if (confirm('受験中のテストを破棄しますか？（記録されません）')) { lsDel('current'); viewHome(); } });
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => viewResult(+b.dataset.test)));
}

/* ---------- 画面: テスト ---------- */
function startTest() {
  const items = buildTest();
  if (items.length < 12) toast('問題が足りないため、出せる分だけ出題します');
  const cur = { items, startedAt: Date.now(), deadline: Date.now() + TIME_LIMIT * 1000, idx: 0, zoom: 1 };
  lsSet('current', cur);
  runTest(cur);
}

function runTest(cur) {
  document.body.classList.add('testing');
  const timerEl = $('#timer'); timerEl.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.round((cur.deadline - Date.now()) / 1000));
    timerEl.textContent = `残り ${fmtTime(left)}`;
    timerEl.classList.toggle('warn', left <= 180);
    if (left <= 0) { clearInterval(timerId); toast('時間切れです。採点します'); finishTest(cur); }
  };
  clearInterval(timerId); timerId = setInterval(tick, 1000); tick();

  const draw = () => {
    const it = cur.items[cur.idx];
    const q = QUESTIONS.find((x) => x.qid === it.qid);
    $('#view').innerHTML = `
      <div class="qhead"><b>${cur.idx + 1} / ${cur.items.length}</b>
        <span class="chip c${q.ch}">${CH_SHORT[q.ch]}</span>
        <span class="muted">${esc(q.exam.label)} ${esc(q.d)}</span></div>
      <div class="qimg" id="qimg"></div>
      ${q.note ? `<div class="note">※このページには${esc(q.d)}以外の問題も含まれます。${esc(q.d)}を解いてください。</div>` : ''}
      <div class="row" style="margin-top:6px">
        <button class="btn again ${it.again ? 'on' : ''}" id="again">${it.again ? '★ またやりたい' : '☆ またやりたい'}</button>
        <span class="spacer"></span>
        <button class="btn" id="viewmode">${viewBtnLabel()}</button>
        <button class="btn" id="zoom">${zoomLabel(cur.zoom)}</button></div>
      <div class="choices">${[1, 2, 3, 4, 5].map((n) => `<button data-c="${n}" class="${it.chosen === n ? 'sel' : ''}">${n}</button>`).join('')}</div>
      <div class="navrow">
        <button class="btn" id="prev" ${cur.idx === 0 ? 'disabled' : ''}>← 前へ</button>
        <button class="btn" id="next" ${cur.idx === cur.items.length - 1 ? 'disabled' : ''}>次へ →</button>
      </div>
      <div class="dots">${cur.items.map((x, i) => `<button data-i="${i}" class="${x.chosen ? 'ans' : ''} ${i === cur.idx ? 'cur' : ''} ${x.again ? 'star' : ''}">${i + 1}</button>`).join('')}</div>
      <button class="big-btn" id="finish">解答を終えて採点する</button>
      <p class="muted" style="text-align:center">未解答 ${cur.items.filter((x) => !x.chosen).length} 問</p>`;
    it.marks = it.marks || {};
    showQuestion(q, $('#qimg'), cur.zoom, { marks: it.marks, save: () => lsSet('current', cur) });
    $('#viewmode').addEventListener('click', () => { viewMode = viewMode === 'text' ? 'pdf' : 'text'; lsSet('viewMode', viewMode); draw(); });
    $('#again').addEventListener('click', () => {
      it.again = !it.again; lsSet('current', cur);
      if (it.again) toast(`チェックしました。${AGAIN_DAYS}日後以降に優先して出題します`);
      draw();
    });
    document.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
      it.chosen = +b.dataset.c; lsSet('current', cur);
      if (cur.idx < cur.items.length - 1) { cur.idx++; lsSet('current', cur); draw(); } else draw();
    }));
    document.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { cur.idx = +b.dataset.i; lsSet('current', cur); draw(); }));
    $('#prev').addEventListener('click', () => { cur.idx--; lsSet('current', cur); draw(); });
    $('#next').addEventListener('click', () => { cur.idx++; lsSet('current', cur); draw(); });
    $('#zoom').addEventListener('click', () => { cur.zoom = cur.zoom === 1 ? 1.5 : cur.zoom === 1.5 ? 2 : 1; lsSet('current', cur); draw(); });
    $('#finish').addEventListener('click', () => {
      const un = cur.items.filter((x) => !x.chosen).length;
      if (confirm(un ? `未解答が${un}問あります（不正解になります）。採点しますか？` : '採点しますか？')) finishTest(cur);
    });
    window.scrollTo(0, 0);
  };
  draw();
}

async function finishTest(cur) {
  clearInterval(timerId);
  if (cur.finished) return; cur.finished = true;
  const now = Date.now();
  const perCh = {};
  let score = 0;
  for (const it of cur.items) {
    const q = QUESTIONS.find((x) => x.qid === it.qid);
    it.correct = q.a.includes(it.chosen);
    perCh[q.ch] = perCh[q.ch] || [0, 0];
    perCh[q.ch][1]++;
    if (it.correct) { perCh[q.ch][0]++; score++; }
    const s = QSTATS.get(it.qid) || { qid: it.qid, attempts: 0, right: 0, wrong: 0, history: [] };
    s.attempts++; it.correct ? s.right++ : s.wrong++;
    s.lastAt = now; s.lastCorrect = it.correct;
    s.history.push({ t: now, ok: it.correct, c: it.chosen });
    // 「またやりたい」: 今回チェックしたら日付を更新、しなければ外す（再出題されたら一度リセット）
    if (it.again) { s.again = true; s.againAt = now; } else { s.again = false; }
    QSTATS.set(it.qid, s);
    await DB.put('qstats', s);
  }
  const test = {
    startedAt: cur.startedAt, finishedAt: now,
    durationSec: Math.min(TIME_LIMIT, Math.round((now - cur.startedAt) / 1000)),
    items: cur.items.map(({ qid, ch, chosen, correct, again }) => ({ qid, ch, chosen, correct, again: !!again })),
    score, perCh, grade: gradeOf(perCh, score, cur.items.length),
  };
  test.id = await DB.put('tests', test);
  TESTS.push(test);
  lsDel('current');
  document.body.classList.remove('testing');
  $('#timer').hidden = true;
  viewResult(test.id);
}

/* ---------- 画面: 結果 ---------- */
function viewResult(id) {
  const t = TESTS.find((x) => x.id === id);
  if (!t) return setTab('home');
  $('#view').innerHTML = `
    <div class="card"><div class="result-top">
      <span class="grade xl ${t.grade}">${t.grade}</span>
      <div><div class="score">${t.score} / ${t.items.length}</div>
      <div>${GRADE_TEXT[t.grade]}</div>
      <div class="muted">${ymd(t.startedAt)}　所要 ${fmtTime(t.durationSec)}</div></div></div></div>
    <div class="card"><h2>章ごとの結果</h2>
      <table class="tbl"><tr><th>章</th><th class="num">正解</th></tr>
      ${[1, 2, 3, 4, 5].map((c) => { const [ok, n] = t.perCh[c] || [0, 0]; const cut = n && ok / n < 0.4;
        return `<tr><td>${CH_SHORT[c]}${cut ? ' <span class="ng">足切り</span>' : ''}</td><td class="num">${ok} / ${n}</td></tr>`; }).join('')}
      </table>
      <p class="muted">判定：A＝12問中9問以上かつ全章で足切りなし（本番の「総得点7割＋各章の基準点」に相当）、B＝8問、C＝6〜7問、D＝4〜5問、E＝3問以下。</p>
    </div>
    <div class="card"><h2>問題ごとの結果（タップで見直し）</h2><div class="qlist">
      ${t.items.map((it, i) => { const q = QUESTIONS.find((x) => x.qid === it.qid);
        return `<button data-rev="${i}"><span class="${it.correct ? 'ok' : 'ng'}">${it.correct ? '○' : '×'}</span>
        <span class="chip c${it.ch}">${it.ch}章</span><span>${q ? `${esc(q.exam.label)} ${esc(q.d)}` : ''}</span>
        <span class="spacer"></span><span class="muted">あなた ${it.chosen ?? '-'}／正答 ${q ? q.a.join('・') : '?'}</span></button>`; }).join('')}
    </div></div>
    <button class="big-btn" id="again">もう1回テストする</button>`;
  document.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', () => viewReview(t, +b.dataset.rev)));
  $('#again').addEventListener('click', startTest);
  window.scrollTo(0, 0);
}

function viewReview(t, i, zoom = 1) {
  const it = t.items[i];
  const q = QUESTIONS.find((x) => x.qid === it.qid);
  const s = QSTATS.get(it.qid);
  $('#view').innerHTML = `
    <div class="qhead"><b>見直し ${i + 1} / ${t.items.length}</b>
      <span class="chip c${q.ch}">${CH_SHORT[q.ch]}</span><span class="muted">${esc(q.exam.label)} ${esc(q.d)}</span></div>
    <div class="qimg" id="qimg"></div>
    <div class="row" style="margin-top:6px">
      <button class="btn again ${s?.again ? 'on' : ''}" id="again">${s?.again ? '★ またやりたい' : '☆ またやりたい'}</button>
      <span class="spacer"></span>
      <button class="btn" id="viewmode">${viewBtnLabel()}</button><button class="btn" id="zoom">${zoomLabel(zoom)}</button></div>
    <div class="choices">${[1, 2, 3, 4, 5].map((n) => `<button disabled class="${q.a.includes(n) ? 'correct' : ''} ${it.chosen === n && !it.correct ? 'wrong' : ''} ${it.chosen === n && it.correct ? 'sel' : ''}">${n}</button>`).join('')}</div>
    <p>${it.correct ? '<span class="ok">正解</span>' : '<span class="ng">不正解</span>'}　正答は <b>${q.a.join('・')}</b>${it.chosen ? `、あなたの解答は ${it.chosen}` : '（未解答）'}</p>
    <p class="muted">この問題の通算：${s ? `${s.attempts}回中 ${s.right}回正解` : '-'}</p>
    <button class="btn pri" id="copyai" style="width:100%;padding:12px;margin:4px 0 8px">🤖 AIに解説を聞く用にコピー</button>
    <p class="muted">解説は公式には公開されていません。ボタンを押すと、問題文・正答・あなたの解答と「解説してください」という依頼文がコピーされます。GeminiなどのAIのチャットに貼り付けて聞いてください。AIの解説にも誤りがあり得るので、最終的にはテキストで確認しましょう。</p>
    <div class="navrow">
      <button class="btn" id="prev" ${i === 0 ? 'disabled' : ''}>← 前へ</button>
      <button class="btn" id="back">結果に戻る</button>
      <button class="btn" id="next" ${i === t.items.length - 1 ? 'disabled' : ''}>次へ →</button></div>`;
  showQuestion(q, $('#qimg'), zoom);
  $('#copyai').addEventListener('click', () => copyForAI(q, it));
  $('#again').addEventListener('click', async () => { // 見直し画面からも付け外しできる
    if (!s) return;
    s.again = !s.again; if (s.again) s.againAt = Date.now();
    await DB.put('qstats', s);
    if (s.again) toast(`チェックしました。${AGAIN_DAYS}日後以降に優先して出題します`);
    viewReview(t, i, zoom);
  });
  $('#viewmode').addEventListener('click', () => { viewMode = viewMode === 'text' ? 'pdf' : 'text'; lsSet('viewMode', viewMode); viewReview(t, i, zoom); });
  $('#zoom').addEventListener('click', () => viewReview(t, i, zoom === 1 ? 1.5 : zoom === 1.5 ? 2 : 1));
  $('#prev').addEventListener('click', () => viewReview(t, i - 1, zoom));
  $('#next').addEventListener('click', () => viewReview(t, i + 1, zoom));
  $('#back').addEventListener('click', () => viewResult(t.id));
  window.scrollTo(0, 0);
}

/* ---------- 画面: カレンダー ---------- */
let calMonth = null, calSel = null;
function viewCalendar() {
  const now = new Date();
  if (!calMonth) calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const byDay = {};
  for (const t of TESTS) (byDay[ymd(t.startedAt)] = byDay[ymd(t.startedAt)] || []).push(t);
  // 1日に複数回受けた日は、点数が一番良い回（同点なら後の回）だけをカレンダーに出す
  const best = {};
  for (const [k, ts] of Object.entries(byDay)) best[k] = ts.reduce((b, t) => (t.score >= b.score ? t : b));
  const first = new Date(calMonth); const startDow = first.getDay();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), 1 - startDow + i);
    cells.push(d);
    if (i >= 34 && d.getMonth() !== first.getMonth() && d.getDay() === 6) break;
  }
  const monthBest = Object.entries(best).filter(([k]) => k.startsWith(`${first.getFullYear()}-${pad2(first.getMonth() + 1)}`)).map(([, t]) => t);
  const selBest = calSel ? best[calSel] : null;
  const others = calSel && byDay[calSel] ? byDay[calSel].filter((t) => t !== selBest) : [];
  const rowOf = (t) => `<button data-test="${t.id}"><span class="grade ${t.grade}">${t.grade}</span><span>${new Date(t.startedAt).toTimeString().slice(0, 5)}　${t.score}/${t.items.length}問</span>
      <span class="spacer"></span><span class="muted">${fmtTime(t.durationSec)}</span></button>`;
  $('#view').innerHTML = `
    <div class="card">
      <div class="cal-head"><button class="btn" id="pm">◀</button>
        <b>${first.getFullYear()}年${first.getMonth() + 1}月</b><button class="btn" id="nm">▶</button></div>
      <div class="cal">${'日月火水木金土'.split('').map((d) => `<div class="dow">${d}</div>`).join('')}
      ${cells.map((d) => { const k = ymd(d); const b = best[k];
        return `<div class="day ${d.getMonth() !== first.getMonth() ? 'out' : ''} ${k === ymd(now) ? 'today' : ''} ${k === calSel ? 'sel' : ''}" data-day="${k}">
          <span>${d.getDate()}</span><div class="gs">${b ? `<span class="grade ${b.grade}">${b.grade}</span><span>${b.score}</span>` : ''}</div></div>`; }).join('')}
      </div>
      <p class="muted">今月：${monthBest.length}日受験 ／ A判定の日 ${monthBest.filter((t) => t.grade === 'A').length}日<br>1日に複数回受けた日は、一番良い結果を表示しています。</p>
    </div>
    ${calSel ? `<div class="card"><h2>${calSel}</h2>${selBest ? `<div class="muted">この日のベスト</div><div class="qlist">${rowOf(selBest)}</div>
      ${others.length ? `<details style="margin-top:8px"><summary class="muted">ほかの回（${others.length}回）</summary><div class="qlist">${others.map(rowOf).join('')}</div></details>` : ''}`
      : '<p class="muted">この日の記録はありません。</p>'}</div>` : ''}`;
  $('#pm').addEventListener('click', () => { calMonth = new Date(first.getFullYear(), first.getMonth() - 1, 1); viewCalendar(); });
  $('#nm').addEventListener('click', () => { calMonth = new Date(first.getFullYear(), first.getMonth() + 1, 1); viewCalendar(); });
  document.querySelectorAll('[data-day]').forEach((el) => el.addEventListener('click', () => { calSel = el.dataset.day; viewCalendar(); }));
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => viewResult(+b.dataset.test)));
}

/* ---------- 画面: 推移 ---------- */
let chart = null, statMode = lsGet('statMode', 'week');
function weekKey(t) { // その週の月曜日
  const d = new Date(t); const dow = (d.getDay() + 6) % 7;
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow));
}
function viewStats() {
  const pool = QUESTIONS.filter(available);
  const rows = [1, 2, 3, 4, 5].map((c) => {
    const qs = pool.filter((q) => q.ch === c);
    let att = 0, ok = 0, seen = 0;
    for (const q of qs) { const s = QSTATS.get(q.qid); if (s) { seen++; att += s.attempts; ok += s.right; } }
    return { c, total: qs.length, seen, att, ok };
  });
  $('#view').innerHTML = `
    <div class="card">
      <div class="row"><h2 style="margin:0">ジャンル別正解率の推移</h2><span class="spacer"></span>
        <div class="seg"><button data-m="week" class="${statMode === 'week' ? 'on' : ''}">週ごと</button>
        <button data-m="roll" class="${statMode === 'roll' ? 'on' : ''}">直近5回</button></div></div>
      ${TESTS.length ? '<div class="chartbox"><canvas id="chart"></canvas></div>' : '<p class="muted">テストを受けると表示されます。</p>'}
      <p class="muted">${statMode === 'week' ? '週ごとに、その週に解いた問題の正解率を章別に集計しています。' : '各回の時点で、直近5回分のテストを合わせた正解率です（1回12問だけだと上下が激しいため）。'}</p>
    </div>
    <div class="card"><h2>章別の累計</h2>
      <table class="tbl"><tr><th>章</th><th class="num">解いた問題</th><th class="num">正解率</th></tr>
      ${rows.map((r) => `<tr><td><span class="chip c${r.c}">${r.c}</span> ${CH_NAMES[r.c]}</td>
        <td class="num">${r.seen}/${r.total}</td><td class="num">${r.att ? Math.round((r.ok / r.att) * 100) + '%' : '-'}</td></tr>`).join('')}
      </table></div>`;
  document.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { statMode = b.dataset.m; lsSet('statMode', statMode); viewStats(); }));
  if (!TESTS.length) return;

  let labels = [], series = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
  if (statMode === 'week') {
    const wk = new Map();
    for (const t of TESTS) {
      const k = weekKey(t.startedAt);
      if (!wk.has(k)) wk.set(k, { 0: [0, 0], 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0], 5: [0, 0] });
      const w = wk.get(k);
      for (const it of t.items) { w[it.ch][1]++; w[0][1]++; if (it.correct) { w[it.ch][0]++; w[0][0]++; } }
    }
    for (const [k, w] of [...wk.entries()].sort()) {
      labels.push(k.slice(5).replace('-', '/') + '週');
      for (const c of [0, 1, 2, 3, 4, 5]) series[c].push(w[c][1] ? Math.round((w[c][0] / w[c][1]) * 100) : null);
    }
  } else {
    TESTS.forEach((t, i) => {
      const win = TESTS.slice(Math.max(0, i - 4), i + 1);
      labels.push(`${i + 1}回目`);
      for (const c of [0, 1, 2, 3, 4, 5]) {
        let ok = 0, n = 0;
        for (const tt of win) for (const it of tt.items) if (c === 0 || it.ch === c) { n++; if (it.correct) ok++; }
        series[c].push(n ? Math.round((ok / n) * 100) : null);
      }
    });
  }
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const ds = [
    { label: '全体', data: series[0], borderColor: col('--ink'), borderWidth: 3, borderDash: [], tension: .25, spanGaps: true },
    ...[1, 2, 3, 4, 5].map((c) => ({ label: CH_SHORT[c], data: series[c], borderColor: col(`--c${c}`), borderWidth: 2, tension: .25, spanGaps: true })),
  ];
  if (chart) chart.destroy();
  chart = new Chart($('#chart'), {
    type: 'line',
    data: { labels, datasets: ds.map((d) => ({ ...d, pointRadius: 3, backgroundColor: d.borderColor })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        y: { min: 0, max: 100, ticks: { callback: (v) => v + '%', color: col('--sub') }, grid: { color: col('--line') } },
        x: { ticks: { color: col('--sub'), maxRotation: 0, autoSkip: true }, grid: { display: false } },
      },
      plugins: {
        legend: { labels: { color: col('--ink'), boxWidth: 12, font: { size: 11 } } },
        annotation: undefined,
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y ?? '-'}%` } },
      },
    },
    plugins: [{ // 合格ライン70%
      id: 'passline',
      afterDraw(ch) {
        const y = ch.scales.y.getPixelForValue(70); const { left, right } = ch.chartArea; const c = ch.ctx;
        c.save(); c.strokeStyle = col('--ng'); c.setLineDash([5, 4]); c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
        c.fillStyle = col('--ng'); c.font = '11px sans-serif'; c.fillText('合格ライン70%', left + 4, y - 4); c.restore();
      },
    }],
  });
}

/* ---------- 画面: データ ---------- */
function viewData() {
  const rows = META.exams.map((e) => {
    const am = HAVE.has(e.files.am.sha256), pm = HAVE.has(e.files.pm.sha256);
    return `<tr><td>${esc(e.label)}</td><td>${am ? '✅' : '—'}</td><td>${pm ? '✅' : '—'}</td>
      <td><a href="${esc(e.source)}" target="_blank" rel="noopener">公式</a></td></tr>`;
  }).join('');
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  $('#view').innerHTML = `
    <div class="card"><h2>過去問PDFの取り込み</h2>
      <p class="muted">受け取ったファイル（touhan_kakomon.dat または .zip）を選んでください。
      展開してしまった場合は、出てきたPDFをまとめて選んでも取り込めます（長押しで複数選択）。
      ファイルの中身で照合するので、ファイル名は変えても大丈夫です。</p>
      <button class="btn pri" id="pick">ファイルを選ぶ</button>
      ${isLocal ? '<button class="btn" id="devload">開発用: ローカルから全部読み込む</button>' : ''}
      <div id="impstat" class="muted" style="margin-top:8px"></div>
    </div>
    <div class="card"><h2>収録している過去問</h2>
      <table class="tbl exams"><tr><th>試験</th><th>午前/前半</th><th>午後/後半</th><th></th></tr>${rows}</table>
      <p class="muted">問題・正答の著作権は各都道府県等にあります。個人の学習用です。</p></div>
    <div class="card"><h2>記録のバックアップ</h2>
      <p class="muted">記録はこのスマホのブラウザ内に保存されています。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</p>
      <div class="row"><button class="btn" id="export">書き出す</button><button class="btn" id="import">読み込む</button></div>
      <p class="muted" id="persist"></p></div>
    <div class="card"><h2>出題の設定</h2>
      <p class="muted">各問題の枠ごとに、次の割合で出題元を選びます。該当する問題がない場合は他から出します。</p>
      <table class="tbl">
        <tr><td>前回間違えた問題</td><td class="num"><input type="number" id="pWrong" min="0" max="100" step="5" value="${Math.round(settings.pWrong * 100)}" style="width:64px">%</td></tr>
        <tr><td>前回正解した問題（${settings.recentDays}日以上前）</td><td class="num"><input type="number" id="pRight" min="0" max="100" step="5" value="${Math.round(settings.pRight * 100)}" style="width:64px">%</td></tr>
        <tr><td>まだ解いていない問題</td><td class="num" id="pUnseen">${Math.round((1 - settings.pWrong - settings.pRight) * 100)}%</td></tr>
      </table>
      <p class="muted">新しい年度の問題ほど出やすくしています（令和8年度は令和4年度の4倍）。<br>
      制度改正の影響を避けるため、第4章（法規）は令和7年度以降、第5章（適正使用・安全対策）は令和6年度以降の問題だけを出題します。第1〜3章は令和4年度以降です。</p></div>
    <div class="card"><h2>リセット</h2><button class="btn danger" id="reset">記録をすべて消す</button></div>`;
  $('#pick').addEventListener('click', () => $('#filepick').click());
  $('#devload')?.addEventListener('click', devLoad);
  $('#export').addEventListener('click', exportBackup);
  $('#import').addEventListener('click', () => $('#backuppick').click());
  $('#reset').addEventListener('click', async () => {
    if (!confirm('受験記録と成績をすべて消します。元に戻せません。よろしいですか？')) return;
    await DB.clear('tests'); await DB.clear('qstats'); lsDel('current');
    TESTS = []; QSTATS = new Map(); toast('記録を消しました'); viewData();
  });
  const onSet = () => {
    let w = Math.max(0, Math.min(100, +$('#pWrong').value || 0)), r = Math.max(0, Math.min(100 - w, +$('#pRight').value || 0));
    settings.pWrong = w / 100; settings.pRight = r / 100; lsSet('settings', settings);
    $('#pUnseen').textContent = `${100 - w - r}%`;
  };
  $('#pWrong').addEventListener('change', onSet); $('#pRight').addEventListener('change', onSet);
  if (navigator.storage?.persisted) navigator.storage.persisted().then((p) => {
    $('#persist').textContent = p ? 'このブラウザでは、データが自動で消されない設定になっています。' : '空き容量が少ないとブラウザがデータを消す場合があります。';
  });
}

async function sha256hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function knownShas() {
  const m = new Map();
  for (const e of META.exams) for (const k of ['am', 'pm']) m.set(e.files[k].sha256, `${e.label} ${k === 'am' ? '午前' : '午後'}`);
  return m;
}
async function importFiles(fileList) {
  const known = knownShas();
  const stat = $('#impstat');
  let added = 0, skipped = 0, unknown = 0;
  const handlePdf = async (name, buf) => {
    const sha = await sha256hex(buf);
    if (!known.has(sha)) { unknown++; return; }
    if (HAVE.has(sha)) { skipped++; return; }
    await DB.put('files', { sha, name, blob: new Blob([buf], { type: 'application/pdf' }), addedAt: Date.now() });
    HAVE.add(sha); added++;
  };
  for (const f of fileList) {
    if (stat) stat.textContent = `処理中: ${f.name}`;
    // ZIPかどうかは中身の先頭（PK\x03\x04）で判定する。Androidで展開されないよう拡張子を .dat にした配布用ファイルも読める
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    if (isZip) {
      const zip = await JSZip.loadAsync(f);
      const entries = Object.values(zip.files).filter((z) => !z.dir && /\.pdf$/i.test(z.name));
      let i = 0;
      for (const z of entries) {
        i++; if (stat) stat.textContent = `ZIP展開中 ${i}/${entries.length}`;
        await handlePdf(z.name, await z.async('arraybuffer'));
      }
    } else {
      await handlePdf(f.name, await f.arrayBuffer());
    }
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
  const msg = `追加 ${added} ／ 取り込み済み ${skipped} ／ 対象外 ${unknown}（正答一覧PDFなどは対象外で問題ありません）`;
  toast(`取り込みました（追加 ${added}件）`);
  if (tab === 'data') { viewData(); $('#impstat').textContent = msg; }
}
async function devLoad() {
  const files = [];
  for (const e of META.exams) for (const k of ['am', 'pm']) {
    const r = await fetch(`../data/pdf/${e.dir}/${e.files[k].name}`);
    if (r.ok) files.push(new File([await r.blob()], e.files[k].name, { type: 'application/pdf' }));
  }
  await importFiles(files);
}

async function exportBackup() {
  const data = { app: 'touhan-mini', version: 1, exportedAt: new Date().toISOString(), tests: await DB.all('tests'), qstats: await DB.all('qstats'), settings };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `touhan-backup-${ymd(Date.now())}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'touhan-mini') throw new Error('このアプリのバックアップではありません');
    if (!confirm(`${data.exportedAt?.slice(0, 10)} のバックアップ（テスト${data.tests.length}回分）で、今の記録を置き換えますか？`)) return;
    await DB.clear('tests'); await DB.clear('qstats');
    for (const t of data.tests) await DB.put('tests', t);
    for (const s of data.qstats) await DB.put('qstats', s);
    if (data.settings) { settings = Object.assign({}, DEFAULT_SETTINGS, data.settings); lsSet('settings', settings); }
    await loadAll(); toast('読み込みました'); viewData();
  } catch (e) { alert('読み込めませんでした: ' + e.message); }
}

/* ---------- 起動 ---------- */
(async () => {
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#filepick').addEventListener('change', async (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) await importFiles(fs); });
  $('#backuppick').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importBackup(f); });
  try {
    await DB.open();
    await loadAll();
  } catch (e) {
    $('#view').innerHTML = `<div class="card">起動できませんでした: ${esc(e.message)}</div>`; return;
  }
  const cur = lsGet('current', null);
  if (cur && Date.now() > cur.deadline) { await finishTest(cur); return; }
  setTab('home');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
