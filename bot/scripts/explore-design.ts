/**
 * 화면 탐색 스크립트 — 디자인·레이아웃·UX 흐름 기록용
 *
 * 하는 일: 브라우저를 눈에 보이게 띄우고, 사용자가 직접 돌아다니는 동안
 *          "무엇을 눌렀고 화면이 어떻게 바뀌었는지" 를 스크린샷과 함께 시간순으로 기록한다.
 *          더불어 화면의 골격(레이아웃 구조)과 디자인 값(색·글꼴·여백·모서리·그림자)을 모은다.
 *
 * 하지 않는 일: 자동으로 클릭·입력하지 않는다. 네트워크 데이터는 보지 않는다(그건 explore.ts).
 *              입력한 글자는 기록하지 않는다.
 *
 * 실행:  npm run design -- --url=https://example.com
 *        npm run design -- --url=https://example.com --mobile
 * 종료:  터미널에 q + Enter  (또는 브라우저 창 닫기)
 * 메모:  터미널에 아무 문장 + Enter → 그 시점 스크린샷 + 메모가 기록에 남는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

// ─────────────────────────────────────────────────────────────────────────────
// 설정 (바꿀 일이 있으면 이 블록만)
// ─────────────────────────────────────────────────────────────────────────────

/** 화면 골격으로 볼 최소 넓이(px²). 이보다 작은 요소는 뼈대가 아니라고 본다. */
const SKELETON_MIN_AREA = 6_000;
/** 골격 트리 최대 깊이 */
const SKELETON_MAX_DEPTH = 4;
/** 골격 트리 최대 줄 수 */
const SKELETON_MAX_NODES = 120;
/** 디자인 값 집계 때 훑을 요소 수 상한 */
const STYLE_SCAN_MAX = 4_000;
/** 집계 결과에서 보여줄 상위 개수 */
const TOP_N = 12;
/** 클릭 후 화면이 바뀌기를 기다리는 시간(ms) */
const AFTER_CLICK_WAIT = 700;
/** 오버레이(모달) 판정: 화면 넓이의 이 비율 이상을 덮으면 모달로 본다 */
const OVERLAY_AREA_RATIO = 0.18;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

// ─────────────────────────────────────────────────────────────────────────────
// 인자
// ─────────────────────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const argOf = (name: string): string | undefined =>
  ARGS.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const hasFlag = (name: string): boolean => ARGS.includes(`--${name}`);

const urlArg = argOf('url');
if (!urlArg) {
  console.error('\n  주소가 필요합니다.\n');
  console.error('  예)  npm run design -- --url=https://example.com');
  console.error('       npm run design -- --url=https://example.com --mobile\n');
  process.exit(1);
}
const START_URL: string = urlArg;

const IS_MOBILE = hasFlag('mobile');
const DEBUG = hasFlag('debug');
const VIEWPORT = IS_MOBILE ? MOBILE : DESKTOP;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = path.resolve(HERE, '..');

const startedAt = new Date();
const hostLabel = (() => {
  try {
    const u = new URL(START_URL);
    const h = u.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9.-]/g, '-');
    return h || path.basename(u.pathname) || 'site';
  } catch { return 'site'; }
})();
const runId = `${hostLabel}-${IS_MOBILE ? 'mobile-' : ''}${stamp(startedAt)}`;
const OUT_DIR = argOf('out')
  ? path.resolve(process.cwd(), argOf('out')!)
  : path.join(BOT_DIR, 'docs', 'design-captures', runId);
const SHOT_DIR = path.join(OUT_DIR, 'shots');
const NDJSON = path.join(OUT_DIR, 'steps.ndjson');

// ─────────────────────────────────────────────────────────────────────────────
// 자료 구조
// ─────────────────────────────────────────────────────────────────────────────

type Rect = { x: number; y: number; w: number; h: number };

type ElementInfo = {
  tag: string;
  sel: string;
  role?: string;
  aria?: string;
  text?: string;
  rect?: Rect;
  href?: string;
};

type SkeletonNode = {
  depth: number;
  sel: string;
  role?: string;
  rect: Rect;
  layout: string;      // block | flex(row) | grid(3열) …
  bg?: string;
  text?: string;
};

type Tally = Record<string, number>;
type Tokens = {
  color: Tally;
  background: Tally;
  fontFamily: Tally;
  fontSize: Tally;
  fontWeight: Tally;
  radius: Tally;
  shadow: Tally;
  gap: Tally;
  padding: Tally;
  maxWidth: Tally;
};

type Step = {
  seq: number;
  at: string;
  sinceMs: number;
  kind: 'navigation' | 'route' | 'click' | 'overlay' | 'marker' | 'resize';
  url: string;
  title?: string;
  note?: string;
  target?: ElementInfo;
  shot?: string;
  skeleton?: SkeletonNode[];
  tokens?: Tokens;
};

const steps: Step[] = [];
let seq = 0;
let finished = false;
let lastShotAt = 0;

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function push(s: Step): void {
  steps.push(s);
  fs.appendFileSync(NDJSON, JSON.stringify(s) + '\n');
}

function short(s: string | undefined, n: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** rgb(a) → #rrggbb. 투명은 그대로 둔다. */
function toHex(v: string): string {
  const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(v.trim());
  if (!m) return v;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  if (a === 0) return 'transparent';
  const hex = '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  return a === 1 ? hex : `${hex} (${Math.round(a * 100)}%)`;
}

function topEntries(t: Tally, n = TOP_N): Array<[string, number]> {
  return Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function mergeTally(into: Tally, from: Tally): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

// ─────────────────────────────────────────────────────────────────────────────
// 페이지에 심는 코드 — 클릭·경로이동·모달을 알려 준다
// ─────────────────────────────────────────────────────────────────────────────

const INIT_SCRIPT = `(() => {
  if (window.__designRecInstalled) return;
  window.__designRecInstalled = true;

  const send = (payload) => {
    try { if (window.__designRec) window.__designRec(payload); } catch (e) { /* 무시 */ }
  };

  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const sel = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    let cls = '';
    const raw = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (raw.trim()) cls = '.' + raw.trim().split(/\\s+/).slice(0, 2).join('.');
    return tag + id + cls;
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;
    return {
      tag: el.tagName.toLowerCase(),
      sel: sel(el),
      role: el.getAttribute('role') || undefined,
      aria: el.getAttribute('aria-label') || undefined,
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) || undefined,
      href: el.getAttribute('href') || undefined,
      rect: rect(el),
    };
  };

  // 아이콘을 눌러도 그걸 감싼 버튼/링크를 보고한다
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[data-testid]';
  document.addEventListener('click', (ev) => {
    const el = ev.target;
    if (!el || el.nodeType !== 1) return;
    const hit = el.closest(INTERACTIVE) || el;
    send({ type: 'click', el: describe(hit), url: location.href, title: document.title });
  }, true);

  // SPA 경로 이동 (pushState/replaceState/뒤로가기)
  const fire = () => send({ type: 'route', url: location.href, title: document.title });
  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name];
    history[name] = function () { const r = orig.apply(this, arguments); setTimeout(fire, 50); return r; };
  }
  addEventListener('popstate', () => setTimeout(fire, 50));

  // 모달·오버레이 감지: 화면을 크게 덮는 요소가 **새로 보이게 되면** 알린다.
  // 숨겨 둔 요소를 보이게 바꾸는 방식이 흔하므로 '새로 생긴 요소'만 보면 놓친다.
  // 처음부터 떠 있던 것은 기준선으로 잡아 두고 보고하지 않는다.
  const open = new Set();
  let ready = false;
  let pending = null;

  const isOverlay = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.position === 'absolute' && Number(cs.zIndex || 0) < 10) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return r.width * r.height >= innerWidth * innerHeight * ${OVERLAY_AREA_RATIO};
  };

  const scan = () => {
    if (!document.body) return;
    const now = new Set();
    const list = document.body.querySelectorAll('div,section,aside,dialog,[role=dialog]');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!isOverlay(el)) continue;
      now.add(el);
      if (open.has(el)) continue;
      open.add(el);
      if (ready) { send({ type: 'overlay', el: describe(el), url: location.href, title: document.title }); return; }
    }
    for (const el of Array.from(open)) if (!now.has(el)) open.delete(el);   // 닫히면 빼 둔다 (다시 열리면 또 기록되게)
  };

  const obs = new MutationObserver(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(scan, 350);
  });

  const start = () => {
    if (!document.body) { setTimeout(start, 100); return; }
    setTimeout(() => {
      scan();          // 기준선 (ready 가 false 라 보고하지 않는다)
      ready = true;
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden'] });
    }, 1200);
  };
  start();
})();`;

// ─────────────────────────────────────────────────────────────────────────────
// 화면에서 읽어 오는 것 — 골격과 디자인 값
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 주의: 아래 두 개는 함수가 아니라 **문자열**로 넘긴다.
 * tsx(esbuild)가 함수 이름을 지키려고 `__name(...)` 헬퍼를 끼워 넣는데,
 * 그 헬퍼는 브라우저 안에 없어서 `page.evaluate(함수)` 가 통째로 실패한다
 * (`ReferenceError: __name is not defined`). 문자열은 변환을 거치지 않아 안전하다.
 */

/** 화면 골격 — 눈에 보이는 큰 덩어리들의 계층·크기·배치 방식 */
const SKELETON_JS = `(() => {
  const MIN_AREA = ${SKELETON_MIN_AREA}, MAX_DEPTH = ${SKELETON_MAX_DEPTH}, MAX_NODES = ${SKELETON_MAX_NODES};
  const out = [];
  const selOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const raw = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    const cls = raw.trim() ? '.' + raw.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return tag + id + cls;
  };
  const layoutOf = (cs) => {
    if (cs.display.indexOf('grid') >= 0) {
      const t = cs.gridTemplateColumns;
      const cols = t && t !== 'none' ? t.trim().split(/\\s+/).length : 0;
      return cols ? 'grid(' + cols + '열)' : 'grid';
    }
    if (cs.display.indexOf('flex') >= 0) {
      const dir = cs.flexDirection.indexOf('column') === 0 ? '세로' : '가로';
      return 'flex(' + dir + (cs.flexWrap === 'wrap' ? '·줄바꿈' : '') + ')';
    }
    return cs.display;
  };
  const walk = (parent, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_NODES) return;
    const kids = parent.children;
    for (let i = 0; i < kids.length; i++) {
      if (out.length >= MAX_NODES) return;
      const child = kids[i];
      const tag = child.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') continue;
      const cs = getComputedStyle(child);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = child.getBoundingClientRect();
      if (r.width * r.height < MIN_AREA) continue;
      const bg = cs.backgroundColor;
      out.push({
        depth: depth,
        sel: selOf(child),
        role: child.getAttribute('role') || undefined,
        rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
        layout: layoutOf(cs),
        bg: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : undefined,
        text: (child.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50) || undefined,
      });
      walk(child, depth + 1);
    }
  };
  if (document.body) walk(document.body, 0);
  return out;
})()`;

/** 디자인 값 — 색·글꼴·크기·여백·모서리·그림자를 쓰인 횟수와 함께 집계 */
const TOKENS_JS = `(() => {
  const MAX = ${STYLE_SCAN_MAX};
  const T = { color: {}, background: {}, fontFamily: {}, fontSize: {}, fontWeight: {}, radius: {}, shadow: {}, gap: {}, padding: {}, maxWidth: {} };
  const bump = (t, k) => {
    if (!k) return;
    const v = String(k).trim();
    if (!v || v === 'none' || v === 'normal' || v === 'auto' || v === '0px' || v === 'rgba(0, 0, 0, 0)') return;
    t[v] = (t[v] || 0) + 1;
  };
  const all = document.querySelectorAll('*');
  const n = Math.min(all.length, MAX);
  for (let i = 0; i < n; i++) {
    const el = all[i];
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link' || tag === 'head' || tag === 'title') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    // 글자색·글꼴은 '직접 글자를 가진 요소'만 센다. 안 그러면 상속으로 숫자가 부풀려진다.
    let own = false;
    for (let j = 0; j < el.childNodes.length; j++) {
      const c = el.childNodes[j];
      if (c.nodeType === 3 && (c.textContent || '').trim().length > 0) { own = true; break; }
    }
    if (own) {
      bump(T.color, cs.color);
      bump(T.fontSize, cs.fontSize);
      bump(T.fontWeight, cs.fontWeight);
      bump(T.fontFamily, cs.fontFamily.split(',')[0].replace(/["']/g, ''));
    }
    bump(T.background, cs.backgroundColor);
    bump(T.radius, cs.borderRadius);
    bump(T.shadow, cs.boxShadow);
    if (cs.display.indexOf('flex') >= 0 || cs.display.indexOf('grid') >= 0) bump(T.gap, cs.gap);
    if (r.width > 200 && r.height > 60) {
      const pad = cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft;
      if (pad !== '0px 0px 0px 0px') bump(T.padding, pad);
    }
    if (cs.maxWidth && cs.maxWidth !== 'none' && cs.maxWidth.slice(-2) === 'px') bump(T.maxWidth, cs.maxWidth);
  }
  return T;
})()`;

async function readSkeleton(page: Page): Promise<SkeletonNode[]> {
  return page.evaluate(SKELETON_JS) as Promise<SkeletonNode[]>;
}

async function readTokens(page: Page): Promise<Tokens> {
  return page.evaluate(TOKENS_JS) as Promise<Tokens>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 기록
// ─────────────────────────────────────────────────────────────────────────────

async function shoot(page: Page, n: number, kind: string, full: boolean): Promise<string | undefined> {
  const name = `${String(n).padStart(4, '0')}-${kind}.png`;
  try {
    await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: full, timeout: 15_000 });
    lastShotAt = Date.now();
    return name;
  } catch {
    // 화면이 넘어가는 중이면 전체 페이지 촬영이 실패한다. 보이는 부분만이라도 남긴다.
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false, timeout: 8_000 });
      return name;
    } catch { return undefined; }
  }
}

/**
 * 기록은 한 번에 하나씩 처리한다.
 * 스크린샷·구조 읽기가 1초 가까이 걸리는데, 그 사이 다른 사건이 끼어들면
 * 번호와 실제 순서가 어긋나고 스크린샷도 엉뚱한 화면이 찍힌다.
 */
let queue: Promise<void> = Promise.resolve();

function record(
  page: Page,
  kind: Step['kind'],
  extra: { note?: string; target?: ElementInfo; url?: string; title?: string } = {},
): Promise<void> {
  const at = new Date();   // 처리 시각이 아니라 '사건이 일어난 시각'을 남긴다
  queue = queue.then(() => doRecord(page, kind, extra, at)).catch(() => {});
  return queue;
}

async function doRecord(
  page: Page,
  kind: Step['kind'],
  extra: { note?: string; target?: ElementInfo; url?: string; title?: string },
  now: Date,
): Promise<void> {
  if (finished) return;
  const n = ++seq;
  const deep = kind === 'navigation' || kind === 'marker' || kind === 'route';

  if (kind === 'click' || kind === 'overlay') await sleep(AFTER_CLICK_WAIT);

  let url = extra.url ?? '';
  let title = extra.title;
  try {
    url = page.url();
    title = await page.title();
  } catch { /* 페이지가 사라졌을 수 있다 */ }

  const shot = await shoot(page, n, kind, deep);
  let skeleton: SkeletonNode[] | undefined;
  let tokens: Tokens | undefined;
  if (deep) {
    skeleton = await readSkeleton(page).catch((e: Error) => { if (DEBUG) console.log('  ! 골격 읽기 실패:', e.message); return undefined; });
    tokens = await readTokens(page).catch((e: Error) => { if (DEBUG) console.log('  ! 디자인 값 읽기 실패:', e.message); return undefined; });
  }

  push({ seq: n, at: now.toISOString(), sinceMs: now.getTime() - startedAt.getTime(), kind, url, title, note: extra.note, target: extra.target, shot, skeleton, tokens });

  const label =
    kind === 'click' ? `클릭 — ${short(extra.target?.text || extra.target?.aria || extra.target?.sel, 40)}`
    : kind === 'marker' ? `📌 ${extra.note}`
    : kind === 'overlay' ? `모달/오버레이 — ${short(extra.target?.text, 40)}`
    : kind === 'route' ? `경로 이동 — ${short(url, 60)}`
    : kind === 'resize' ? `화면 크기 변경`
    : `이동 — ${short(url, 60)}`;
  console.log(`[${String(n).padStart(4, '0')}] ${label}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 보고서
// ─────────────────────────────────────────────────────────────────────────────

function buildReport(meta: { browser: string; userAgent: string; endedAt: Date }): string {
  const L: string[] = [];
  const flow = steps.filter((s) => s.kind !== 'resize').sort((a, b) => a.seq - b.seq);

  L.push(`# 화면 탐색 기록 — ${hostLabel}`, '');
  L.push('> `explore-design.ts` 가 자동 생성했다. 결론은 사람이 따로 정리한다.', '');

  L.push('## 실행 정보', '');
  L.push(`- 대상: ${START_URL}`);
  L.push(`- 시작: ${startedAt.toLocaleString('ko-KR')} · 종료: ${meta.endedAt.toLocaleString('ko-KR')}`);
  L.push(`- 화면 크기: ${VIEWPORT.width}×${VIEWPORT.height} ${IS_MOBILE ? '(모바일)' : '(데스크톱)'}`);
  L.push(`- 브라우저: ${meta.browser}`);
  L.push(`- 기록한 단계: ${flow.length}개`, '');

  // ── 한눈에 보는 흐름
  L.push('## UX 흐름 요약', '');
  const acts = flow.filter((s) => s.kind === 'click' || s.kind === 'overlay' || s.kind === 'marker' || s.kind === 'navigation' || s.kind === 'route');
  if (acts.length === 0) {
    L.push('_기록된 동작이 없다._', '');
  } else {
    L.push('| # | 시간 | 무엇 | 내용 | 결과 화면 |');
    L.push('|---|---|---|---|---|');
    for (const s of acts) {
      const t = `${Math.floor(s.sinceMs / 1000)}초`;
      const what =
        s.kind === 'click' ? '클릭' : s.kind === 'overlay' ? '모달' :
        s.kind === 'marker' ? '메모' : s.kind === 'route' ? '경로' : '이동';
      const detail =
        s.kind === 'marker' ? short(s.note, 60)
        : s.kind === 'click' ? `\`${s.target?.sel ?? '?'}\` — ${short(s.target?.text || s.target?.aria, 40) || '(글자 없음)'}`
        : s.kind === 'overlay' ? short(s.target?.text, 50) || `\`${s.target?.sel ?? '?'}\``
        : short(s.url.replace(/^https?:\/\/[^/]+/, ''), 50) || '/';
      L.push(`| ${s.seq} | ${t} | ${what} | ${detail} | ${short(s.title, 30)} |`);
    }
    L.push('');
  }

  // ── 방문한 화면
  const pages = new Map<string, { title?: string; first: number }>();
  for (const s of flow) {
    if (s.kind !== 'navigation' && s.kind !== 'route') continue;
    if (!pages.has(s.url)) pages.set(s.url, { title: s.title, first: s.seq });
  }
  if (pages.size) {
    L.push('## 방문한 화면', '');
    for (const [url, v] of pages) L.push(`- [${v.first}] ${v.title ? `**${v.title}** — ` : ''}\`${url}\``);
    L.push('');
  }

  // ── 디자인 값 (전체 합산)
  const all: Tokens = { color: {}, background: {}, fontFamily: {}, fontSize: {}, fontWeight: {}, radius: {}, shadow: {}, gap: {}, padding: {}, maxWidth: {} };
  for (const s of flow) {
    if (!s.tokens) continue;
    for (const k of Object.keys(all) as Array<keyof Tokens>) mergeTally(all[k], s.tokens[k] ?? {});
  }
  const hasTokens = Object.values(all).some((t) => Object.keys(t).length > 0);
  if (hasTokens) {
    L.push('## 디자인 값 (본 화면 전체 합산)', '');
    L.push('숫자는 그 값이 쓰인 요소 수. 위에 있을수록 이 사이트의 기본값이다.', '');

    const block = (title: string, t: Tally, fmt: (k: string) => string = (k) => `\`${k}\``) => {
      const rows = topEntries(t);
      if (!rows.length) return;
      L.push(`### ${title}`, '');
      for (const [k, v] of rows) L.push(`- ${fmt(k)} — ${v}`);
      L.push('');
    };

    block('글자색', all.color, (k) => `\`${toHex(k)}\``);
    block('배경색', all.background, (k) => `\`${toHex(k)}\``);
    block('글꼴', all.fontFamily);
    block('글자 크기', all.fontSize);
    block('글자 굵기', all.fontWeight);
    block('모서리 둥글기', all.radius);
    block('그림자', all.shadow);
    block('요소 간격(gap)', all.gap);
    block('안쪽 여백(padding)', all.padding);
    block('본문 최대 폭', all.maxWidth);
  }

  // ── 화면별 상세
  L.push('## 화면별 상세', '');
  for (const s of flow) {
    const t = `${Math.floor(s.sinceMs / 1000)}초`;
    const head =
      s.kind === 'click' ? `클릭 — ${short(s.target?.text || s.target?.aria || s.target?.sel, 50)}`
      : s.kind === 'marker' ? `📌 ${s.note}`
      : s.kind === 'overlay' ? `모달/오버레이`
      : s.kind === 'route' ? `경로 이동`
      : `이동`;
    L.push(`### [${s.seq}] ${t} · ${head}`, '');
    L.push(`- 주소: \`${s.url}\``);
    if (s.title) L.push(`- 제목: ${s.title}`);
    if (s.target) {
      L.push(`- 대상: \`${s.target.sel}\`${s.target.role ? ` (role=${s.target.role})` : ''}`);
      if (s.target.href) L.push(`- 링크: \`${s.target.href}\``);
      if (s.target.rect) L.push(`- 위치·크기: x${s.target.rect.x} y${s.target.rect.y} · ${s.target.rect.w}×${s.target.rect.h}`);
    }
    if (s.shot) L.push('', `![${s.seq}](shots/${s.shot})`, '');
    if (s.skeleton?.length) {
      L.push('<details><summary>화면 골격</summary>', '');
      L.push('```');
      for (const n of s.skeleton) {
        const pad = '  '.repeat(n.depth);
        const bits = [`${n.sel}`, `${n.rect.w}×${n.rect.h}`, n.layout];
        if (n.role) bits.push(`role=${n.role}`);
        if (n.bg) bits.push(toHex(n.bg));
        L.push(`${pad}${bits.join('  ·  ')}${n.text ? `   "${n.text}"` : ''}`);
      }
      L.push('```', '');
      L.push('</details>', '');
    }
  }

  L.push('## 정리할 때 볼 것', '');
  L.push('- [ ] 첫 화면에서 가장 먼저 눈에 들어오는 것은 무엇인가? 우리 화면의 그것과 같은가?');
  L.push('- [ ] 목표(예약·조회)까지 몇 번 눌러야 하는가? 우리는 몇 번인가?');
  L.push('- [ ] 정보를 한 화면에 다 보여주는가, 단계로 나누는가?');
  L.push('- [ ] 모달을 쓰는가, 페이지 이동을 쓰는가?');
  L.push('- [ ] 글자 크기 단계가 몇 개인가? (위 "글자 크기" 목록)');
  L.push('- [ ] 색은 몇 개로 쓰는가? 강조색은 무엇인가?');
  L.push('- [ ] 우리 화면에 그대로 가져올 만한 것 하나만 고른다면?');
  L.push('');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  console.log('');
  console.log(`  화면 탐색 — ${hostLabel} ${IS_MOBILE ? '(모바일 화면)' : '(데스크톱 화면)'}`);
  console.log('  ────────────────────────────────────────────────────────');
  console.log('  이 창은 아무것도 자동으로 누르지 않습니다. 직접 돌아다니세요.');
  console.log('  누를 때마다 무엇을 눌렀는지 + 스크린샷이 기록됩니다.');
  console.log('');
  console.log('  터미널에 문장 + Enter  →  그 시점 스크린샷 + 메모 (예: "여기가 예약 첫 화면")');
  console.log('  터미널에 q + Enter     →  브라우저 닫고 보고서 작성');
  console.log('  ────────────────────────────────────────────────────────');
  console.log('');

  let browser: Browser;
  let browserLabel: string;
  try {
    browser = await chromium.launch({ headless: false, channel: 'chrome' });
    browserLabel = `Chrome (channel) ${browser.version()}`;
  } catch {
    browser = await chromium.launch({ headless: false });
    browserLabel = `Playwright Chromium ${browser.version()}`;
  }

  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: IS_MOBILE,
    hasTouch: IS_MOBILE,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });

  // 페이지에서 올려 보내는 신호를 받는다
  await context.exposeBinding('__designRec', async (source, payload: any) => {
    if (finished || !payload) return;
    const page = source.page;
    if (payload.type === 'click') {
      await record(page, 'click', { target: payload.el ?? undefined, url: payload.url, title: payload.title }).catch(() => {});
    } else if (payload.type === 'route') {
      await record(page, 'route', { url: payload.url, title: payload.title }).catch(() => {});
    } else if (payload.type === 'overlay') {
      await record(page, 'overlay', { target: payload.el ?? undefined, url: payload.url, title: payload.title }).catch(() => {});
    }
  });
  await context.addInitScript(INIT_SCRIPT);

  // context 의 'page' 이벤트는 우리가 직접 만든 탭에도 오므로, 두 번 붙지 않게 막는다
  const attached = new WeakSet<Page>();
  const attach = (page: Page) => {
    if (attached.has(page)) return;
    attached.add(page);
    if (DEBUG) {
      page.on('pageerror', (e) => console.log('  ! 페이지 오류:', e.message));
      page.on('console', (m) => { if (m.type() === 'error') console.log('  ! 콘솔:', m.text().slice(0, 200)); });
    }
    page.on('load', () => {
      if (page.url() === 'about:blank') return;   // 빈 탭은 화면이 아니다
      void record(page, 'navigation').catch(() => {});
    });
    page.on('popup', (p) => attach(p));
  };
  context.on('page', (p) => attach(p));

  const page = await context.newPage();
  attach(page);

  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '(확인 실패)');
  fs.writeFileSync(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify({ runId, startUrl: START_URL, viewport: VIEWPORT, mobile: IS_MOBILE, browser: browserLabel, userAgent, startedAt: startedAt.toISOString() }, null, 2),
  );

  console.log(`  브라우저: ${browserLabel}`);
  console.log(`  기록 위치: ${path.relative(process.cwd(), OUT_DIR)}`);
  console.log('');

  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (e) {
    console.log(`  ⚠ 여는 데 실패했습니다: ${(e as Error).message}`);
    console.log('    브라우저 주소창에 직접 입력해 계속하셔도 됩니다.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

  const finish = async (why: string): Promise<void> => {
    if (finished) return;
    finished = true;
    console.log(`\n  기록을 정리합니다… (${why})`);
    rl.close();
    try { await browser.close(); } catch { /* 이미 닫혔을 수 있다 */ }

    const reportPath = path.join(OUT_DIR, 'report.md');
    fs.writeFileSync(reportPath, buildReport({ browser: browserLabel, userAgent, endedAt: new Date() }));

    console.log('');
    console.log('  ────────────────────────────────────────────────────────');
    console.log(`  단계 ${steps.length}개 · 스크린샷 ${steps.filter((s) => s.shot).length}장`);
    console.log(`  보고서:  ${path.relative(process.cwd(), reportPath)}`);
    console.log(`  스크린샷: ${path.relative(process.cwd(), SHOT_DIR)}/`);
    console.log(`  원자료:  ${path.relative(process.cwd(), NDJSON)}`);
    console.log('  ────────────────────────────────────────────────────────');
    console.log('');
    process.exit(0);
  };

  rl.on('line', (line) => {
    const t = line.trim();
    if (t === 'q' || t === 'quit' || t === '종료') { void finish('사용자 종료'); return; }
    if (!t) return;
    void record(page, 'marker', { note: t }).catch(() => {});
  });

  rl.on('SIGINT', () => { void finish('Ctrl+C'); });
  process.on('SIGINT', () => { void finish('Ctrl+C'); });
  process.on('SIGTERM', () => { void finish('SIGTERM'); });
  process.on('SIGHUP', () => { void finish('터미널 종료'); });
  browser.on('disconnected', () => { void finish('브라우저 창이 닫힘'); });
}

main().catch((err) => {
  console.error('\n  실패:', (err as Error).message);
  process.exit(1);
});
