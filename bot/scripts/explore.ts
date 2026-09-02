/**
 * Phase 0 탐색 스크립트 (리조트 공용)
 *
 * 하는 일: 브라우저를 눈에 보이게 띄우고, 사용자가 직접 로그인 → 검색 → 달력 → 날짜 모달까지
 *          진행하는 동안 오가는 네트워크 요청을 전부 기록한다.
 *          목적은 "달력·요금 데이터가 JSON API 로 오는가, 온다면 URL/파라미터가 무엇인가" 확인.
 *
 * 하지 않는 일: 클릭·입력·예약 등 어떤 조작도 하지 않는다. 오직 관찰과 기록만 한다.
 *
 * 실행:  npm run explore:sono
 * 종료:  터미널에 q + Enter  (또는 Ctrl+C, 또는 브라우저 창 닫기)
 * 메모:  터미널에 아무 문장이나 + Enter → 그 시점이 기록에 단계 표시로 남는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';

import { getSonoCredentials } from '../src/secrets.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 상수 (사이트가 바뀌면 이 블록만 고친다)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 리조트별 시작점.
 * `login` 이 있는 리조트만 --login(자동 로그인)을 쓸 수 있다.
 * 아직 구조를 모르는 리조트는 브라우저에서 직접 로그인하면 된다 — 기록은 똑같이 남는다.
 */
const RESORTS: Record<string, {
  name: string;
  startUrl: string;
  login?: {
    loginUrl: string;
    /** 로그인 뒤 자동으로 열 주소. 로그인 다음 단계가 더 있는 리조트는 비워 둔다. */
    afterUrl?: string;
    sel: { loginId: string; loginPw: string; loginSubmit: string };
  };
}> = {
  sono: {
    name: '소노',
    startUrl: 'https://www.sonohotelsresorts.com/',
    login: {
      loginUrl: 'https://www.sonohotelsresorts.com/member/login',
      afterUrl: 'https://www.sonohotelsresorts.com/reserve/room?step=sch',
      sel: { loginId: '#lginId', loginPw: '#lginPw', loginSubmit: 'button.btn.xl.fill:has-text("로그인")' },
    },
  },
  anantti: {
    name: '아난티',
    startUrl: 'https://ananti.kr/ko/',   // TODO(verify) 로그인 페이지 주소는 탐색으로 확인
  },
  hanwha: {
    name: '한화',
    startUrl: 'https://booking.hanwharesort.co.kr/rst/rrs/0010/serviceM00.mvc',
    login: {
      loginUrl: 'https://www.hanwharesort.co.kr/irsweb/resort3/member/login.do',
      // 한화는 로그인 뒤 '회원권 비밀번호' 단계가 하나 더 있다.
      // 그 화면 구조를 아직 모르므로 자동으로 넘기지 않고 사람이 진행한다.
      afterUrl: undefined,
      // 2026-09-02 확인: 캡차·보안키패드 없음. 로그인 버튼은 <input type="button">
      sel: { loginId: '#id', loginPw: '#pwd', loginSubmit: '#btnLogin' },
    },
  },
};

const RESORT_ID = process.argv.find((a) => a.startsWith('--resort='))?.slice('--resort='.length) ?? 'sono';
const RESORT = RESORTS[RESORT_ID];
if (!RESORT) {
  console.error(`모르는 리조트입니다: ${RESORT_ID} (가능: ${Object.keys(RESORTS).join(', ')})`);
  process.exit(1);
}

const START_URL = RESORT.startUrl;

/** 기록하지 않을 도메인 — 호스트 이름으로만 판정한다 (URL 부분 문자열로 보면 catalog.json 같은 게 걸린다) */
const NOISE_HOST_SUFFIX = [
  'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com', 'googleadservices.com',
  'doubleclick.net', 'adsystem.com', 'facebook.com', 'facebook.net', 'criteo.com', 'criteo.net',
  'hotjar.com', 'clarity.ms', 'sentry.io', 'newrelic.com', 'appsflyer.com', 'braze.com',
  'channel.io', 'tiara.kakao.com', 'wcs.naver.net', 'wcs.naver.com',
];

/** 잡음 서브도메인 접두사 */
const NOISE_HOST_PREFIX = ['ad.', 'ads.', 'log.', 'logs.', 'stat.', 'stats.', 'analytics.', 'beacon.', 'pixel.', 'track.', 'tracking.'];

/** 경로만 봐도 통계·광고인 것 */
const NOISE_PATH = ['/tiara/', '/collect?', '/gtag/js', '/gtm.js'];

/** 본문을 저장할 리소스 종류 (나머지는 요청 사실만 기록) */
const BODY_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

/** 아예 기록하지 않을 리소스 종류 */
const IGNORED_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'websocket', 'manifest', 'script']);

/** 예약·요금 관련 후보 엔드포인트를 골라내는 힌트 단어 */
const CANDIDATE_HINTS = /(calendar|month|day|date|stay|night|room|price|amount|pay|fee|rest|remain|avail|vacan|resv|reserv|booking|search|product|goods|type|view|inventory)/i;

/**
 * 로그인·인증 계열 URL — 본문을 통째로 가린다.
 * 2026-09-02: 한화의 `/static/j_spring_security_check.sec` 가 이 목록을 빠져나가
 * 아이디·비밀번호가 평문으로 기록됐다. 그래서 `security`·`check` 계열을 넣었다.
 */
const AUTH_URL = /(login|logon|signin|sign-in|auth|oauth|token|cert|passwd|password|captcha|security|j_spring|_check|\.sec\b|session)/i;

/** 값을 가려야 하는 파라미터 이름 (기호 제거 후 소문자로 비교) */
const SENSITIVE_KEYS = new Set([
  'pw', 'pwd', 'passwd', 'password', 'pass', 'userpw', 'userpassword', 'memberpw', 'mbrpw', 'loginpw',
  'secret', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization', 'apikey',
  'sessionid', 'jsessionid', 'otp', 'jumin', 'ssn', 'rrn',
  'birth', 'birthday', 'birthdate', 'hp', 'hphone', 'mobile', 'mobileno', 'phone', 'phoneno',
  'tel', 'telno', 'email', 'mail', 'emailaddr', 'cardno', 'cardnumber',
  // 회원 개인정보 계열. 단순 'name' 은 일부러 넣지 않는다 — 숙소·객실 이름이 전부 name 이라 가리면 탐색이 무의미해진다.
  'memberid', 'userid', 'loginid', 'mbrid', 'custid',
  'membername', 'username', 'usernm', 'mbrnm', 'mbrname', 'custname', 'custnm', 'nickname',
  'addr', 'address', 'addr1', 'addr2', 'zipcode', 'postcode',
]);

/**
 * 기록할 요청 헤더. 쿠키·인증 헤더는 아예 읽지 않는다.
 * x-* 사용자 정의 헤더는 **이름을 남기는 것이 중요하다** — 이게 없어서 아난티에서 403 을 겪었다.
 * 다만 토큰처럼 보이는 값은 가린다.
 */
const KEEP_REQ_HEADERS = ['content-type', 'accept', 'referer'];
const TOKENISH = /(token|csrf|xsrf|auth|key|secret|session)/i;

const BODY_SAVE_MAX = 2_000_000;   // 2MB 넘는 본문은 저장하지 않음
const TEXT_SAVE_MAX = 200_000;     // HTML/텍스트는 200KB 까지만
const BODY_READ_TIMEOUT = 5_000;   // 본문 읽기 대기 한도

// ─────────────────────────────────────────────────────────────────────────────
// 준비
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = path.resolve(HERE, '..');

const DO_LOGIN = process.argv.includes('--login');
const argUrl = process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const startUrl = argUrl || START_URL;

let startedAt = new Date();
let runId = `${RESORT_ID}-${stamp(startedAt)}`;
let OUT_DIR = path.join(BOT_DIR, 'docs', 'captures', runId);
let BODY_DIR = path.join(OUT_DIR, 'bodies');
let NDJSON = path.join(OUT_DIR, 'entries.ndjson');

type Entry = {
  kind: 'request' | 'marker' | 'navigation' | 'failed';
  seq: number;
  at: string;
  sinceMs: number;
  note?: string;                          // marker
  method?: string;
  url?: string;
  host?: string;
  pathname?: string;
  query?: Record<string, string>;
  resourceType?: string;
  reqHeaders?: Record<string, string>;
  postData?: string | null;
  status?: number;
  contentType?: string;
  bytes?: number;
  bodyKind?: 'json' | 'html' | 'text' | 'binary' | 'too-large' | 'redacted' | 'none' | 'error';
  bodyFile?: string;
  jsonShape?: string[];
  hints?: string[];
  error?: string;
};

const entries: Entry[] = [];
let seq = 0;
let finished = false;

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normKey(k: string): string {
  return k.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * 부분 일치로도 걸러낸다.
 * 이름을 정확히 나열하는 방식만으로는 `j_password` 처럼 접두사가 붙은 필드를 놓친다.
 */
const SENSITIVE_PARTS = /(password|passwd|secret|token|credential|username|userid|loginid|memberid|custid|jumin|ssn)/;

function isSensitive(k: string): boolean {
  const n = normKey(k);
  return SENSITIVE_KEYS.has(n) || SENSITIVE_PARTS.test(n) || /pwd?$/.test(n);
}

function isNoise(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (NOISE_HOST_SUFFIX.some((h) => host === h || host.endsWith('.' + h))) return true;
  if (NOISE_HOST_PREFIX.some((p) => host.startsWith(p))) return true;
  return NOISE_PATH.some((p) => url.includes(p));
}

/** 본문 텍스트에서 개인정보로 보이는 문자열을 지운다 (구조는 그대로 둔다) */
function scrubText(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .replace(/\b01[016-9][-. ]?\d{3,4}[-. ]?\d{4}\b/g, '[PHONE]')
    .replace(/\b\d{6}[-]\d{7}\b/g, '[RRN]');
}

/** JSON 안의 민감한 키 값을 가린다 */
function maskJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => maskJson(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitive(k) ? '[MASKED]' : maskJson(v, depth + 1);
    }
    return out;
  }
  return value;
}

function maskQuery(u: URL): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of u.searchParams) q[k] = isSensitive(k) ? '[MASKED]' : v;
  return q;
}

/** POST 본문 정리: 인증 계열은 통째로 가리고, 나머지는 키 단위로 가린다 */
function maskPostData(url: string, raw: string | null): string | null {
  if (!raw) return null;
  if (AUTH_URL.test(url)) return '[REDACTED: 인증 계열 요청 — 본문 기록 안 함]';
  const trimmed = raw.length > 8000 ? raw.slice(0, 8000) + ' …(잘림)' : raw;
  try {
    return JSON.stringify(maskJson(JSON.parse(trimmed)));
  } catch { /* JSON 이 아님 */ }
  if (/^[^=&\s]+=/.test(trimmed)) {
    return trimmed
      .split('&')
      .map((pair) => {
        const i = pair.indexOf('=');
        if (i < 0) return pair;
        const k = pair.slice(0, i);
        return isSensitive(decodeURIComponent(k)) ? `${k}=[MASKED]` : pair;
      })
      .join('&');
  }
  return scrubText(trimmed);
}

/** 응답 내용에서 눈에 띄는 신호를 뽑는다 (달력인지, 금액이 들어 있는지) */
function detectHints(pathname: string, text: string): string[] {
  const hints: string[] = [];
  const dates = text.match(/\b20\d{2}[-.\/]?[01]\d[-.\/]?[0-3]\d\b/g);
  if (dates && dates.length >= 20) hints.push(`날짜 ${dates.length}개 — 달력 후보`);
  if (/("|\b)(price|amount|fee|totalPrice|salePrice|roomPrice|payAmt|dcAmt)("|\b)/i.test(text)) hints.push('금액 필드 있음');
  if (/(마감임박|예약대기|예약가능|마감|잔여|대기)/.test(text)) hints.push('상태 텍스트(마감임박/예약대기 등) 있음');
  if (/(스마트요금|할인|discount|dc)/i.test(text)) hints.push('할인 관련 필드 있음');
  if (CANDIDATE_HINTS.test(pathname)) hints.push('URL 이 예약/객실 관련');
  return hints;
}

/** 이미 확장자가 붙어 있으면 또 붙이지 않는다 (catalog.json.json 방지) */
function withExt(base: string, ext: string): string {
  return base.toLowerCase().endsWith('.' + ext) ? base : `${base}.${ext}`;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'root';
}

function push(e: Entry): void {
  entries.push(e);
  try {
    fs.appendFileSync(NDJSON, JSON.stringify(e) + '\n');
  } catch { /* 기록 실패로 탐색을 멈추지는 않는다 */ }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 기록
// ─────────────────────────────────────────────────────────────────────────────

async function onResponse(res: Response): Promise<void> {
  const url = res.url();
  if (url.startsWith('data:') || url.startsWith('blob:')) return;
  if (isNoise(url)) return;

  const req = res.request();
  const resourceType = req.resourceType();
  if (IGNORED_RESOURCE_TYPES.has(resourceType)) return;

  const n = ++seq;
  const now = new Date();
  let u: URL;
  try { u = new URL(url); } catch { return; }

  const reqHeaders: Record<string, string> = {};
  try {
    const all = await withTimeout(req.allHeaders(), 1000);
    if (all) {
      for (const h of KEEP_REQ_HEADERS) if (all[h]) reqHeaders[h] = all[h];
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith('x-') || k.startsWith('x-forwarded')) continue;
        reqHeaders[k] = TOKENISH.test(k) ? '[MASKED]' : v;
      }
    }
  } catch { /* 헤더를 못 읽어도 계속 */ }

  const entry: Entry = {
    kind: 'request',
    seq: n,
    at: now.toISOString(),
    sinceMs: now.getTime() - startedAt.getTime(),
    method: req.method(),
    url: `${u.origin}${u.pathname}`,
    host: u.host,
    pathname: u.pathname,
    query: maskQuery(u),
    resourceType,
    reqHeaders,
    postData: maskPostData(url, req.postData()),
    status: res.status(),
    contentType: (res.headers()['content-type'] ?? '').split(';')[0] || undefined,
    bodyKind: 'none',
  };

  if (BODY_RESOURCE_TYPES.has(resourceType) && res.status() < 400) {
    if (AUTH_URL.test(url)) {
      entry.bodyKind = 'redacted';
    } else {
      const buf = await withTimeout(res.body().catch(() => null), BODY_READ_TIMEOUT);
      if (!buf) {
        entry.bodyKind = 'error';
      } else if (buf.byteLength > BODY_SAVE_MAX) {
        entry.bodyKind = 'too-large';
        entry.bytes = buf.byteLength;
      } else {
        entry.bytes = buf.byteLength;
        const ct = entry.contentType ?? '';
        const text = buf.toString('utf8');
        const base = `${String(n).padStart(4, '0')}-${safeName(u.pathname.split('/').filter(Boolean).slice(-2).join('-'))}`;
        try {
          const parsed = JSON.parse(text);
          const masked = maskJson(parsed);
          const file = withExt(base, 'json');
          fs.writeFileSync(path.join(BODY_DIR, file), scrubText(JSON.stringify(masked, null, 2)));
          entry.bodyKind = 'json';
          entry.bodyFile = `bodies/${file}`;
          entry.jsonShape = Array.isArray(parsed)
            ? [`array(${parsed.length})`, ...(parsed[0] && typeof parsed[0] === 'object' ? Object.keys(parsed[0]).slice(0, 30) : [])]
            : Object.keys(parsed ?? {}).slice(0, 30);
        } catch {
          if (/^(text|application)\//.test(ct) || /^\s*[<{[]/.test(text)) {
            const ext = ct.includes('html') || /^\s*</.test(text) ? 'html' : 'txt';
            const file = withExt(base, ext);
            fs.writeFileSync(path.join(BODY_DIR, file), scrubText(text.slice(0, TEXT_SAVE_MAX)));
            entry.bodyKind = ext === 'html' ? 'html' : 'text';
            entry.bodyFile = `bodies/${file}`;
          } else {
            entry.bodyKind = 'binary';
          }
        }
        entry.hints = detectHints(u.pathname, text.slice(0, 400_000));
      }
    }
  }

  push(entry);

  const tag = entry.resourceType === 'document' ? '문서' : (entry.resourceType ?? '').toUpperCase();
  const size = entry.bytes ? ` ${(entry.bytes / 1024).toFixed(1)}KB` : '';
  const hint = entry.hints?.length ? `  ← ${entry.hints.join(', ')}` : '';
  console.log(`[${String(n).padStart(4, '0')}] ${tag} ${entry.status} ${entry.method} ${u.pathname}${size} ${entry.bodyKind}${hint}`);
}

function onNavigation(url: string): void {
  if (isNoise(url) || url === 'about:blank') return;
  const n = ++seq;
  const now = new Date();
  let shown = url;
  try {
    const u = new URL(url);
    shown = `${u.origin}${u.pathname}${u.search ? '?' + new URLSearchParams(maskQuery(u)).toString() : ''}`;
  } catch { /* 그대로 */ }
  push({ kind: 'navigation', seq: n, at: now.toISOString(), sinceMs: now.getTime() - startedAt.getTime(), url: shown });
  console.log(`[${String(n).padStart(4, '0')}] ── 페이지 이동: ${shown}`);
}

const attached = new WeakSet<Page>();

function attachPage(page: Page): void {
  if (attached.has(page)) return;
  attached.add(page);
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) onNavigation(frame.url());
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 보고서
// ─────────────────────────────────────────────────────────────────────────────

function buildReport(meta: { browser: string; userAgent: string; endedAt: Date; startUrl: string }): string {
  const reqs = entries.filter((e) => e.kind === 'request');
  const xhr = reqs.filter((e) => BODY_RESOURCE_TYPES.has(e.resourceType ?? ''));

  type Group = {
    key: string; method: string; host: string; pathname: string;
    count: number; statuses: Set<number>; queryKeys: Set<string>; bodyKeys: Set<string>;
    kinds: Set<string>; shapes: Set<string>; hints: Set<string>; samples: string[]; firstSeq: number;
  };
  const groups = new Map<string, Group>();
  for (const e of xhr) {
    const key = `${e.method} ${e.host}${e.pathname}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, method: e.method!, host: e.host!, pathname: e.pathname!, count: 0, statuses: new Set(), queryKeys: new Set(), bodyKeys: new Set(), kinds: new Set(), shapes: new Set(), hints: new Set(), samples: [], firstSeq: e.seq };
      groups.set(key, g);
    }
    g.count++;
    if (e.status) g.statuses.add(e.status);
    for (const k of Object.keys(e.query ?? {})) g.queryKeys.add(k);
    if (e.postData) {
      try { for (const k of Object.keys(JSON.parse(e.postData))) g.bodyKeys.add(k); }
      catch { for (const p of e.postData.split('&')) { const i = p.indexOf('='); if (i > 0) g.bodyKeys.add(p.slice(0, i)); } }
    }
    if (e.bodyKind) g.kinds.add(e.bodyKind);
    for (const s of e.jsonShape ?? []) g.shapes.add(s);
    for (const h of e.hints ?? []) g.hints.add(h);
    if (e.bodyFile && g.samples.length < 3) g.samples.push(e.bodyFile);
  }

  const sorted = [...groups.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  const candidates = sorted.filter((g) => g.hints.size > 0 || CANDIDATE_HINTS.test(g.pathname));

  const L: string[] = [];
  L.push(`# ${RESORT.name} 사이트 탐색 기록 — ${runId}`, '');
  L.push('> 이 파일은 `explore-sono.ts` 가 자동 생성했다. 사람이 정리한 결론은 `bot/docs/sono-site-notes.md` 에 적는다.', '');
  L.push('## 실행 정보', '');
  L.push(`- 시작: ${startedAt.toLocaleString('ko-KR')}`);
  L.push(`- 종료: ${meta.endedAt.toLocaleString('ko-KR')}`);
  L.push(`- 시작 URL: ${meta.startUrl}`);
  L.push(`- 브라우저: ${meta.browser}`);
  L.push(`- User-Agent: \`${meta.userAgent}\``);
  L.push(`- 기록한 요청: ${reqs.length}건 (그중 XHR/fetch ${xhr.length}건, 엔드포인트 ${groups.size}종)`);
  L.push(`- 원문 저장 위치: \`docs/captures/${runId}/bodies/\``, '');

  const markers = entries.filter((e) => e.kind === 'marker' || e.kind === 'navigation');
  L.push('## 단계 타임라인', '');
  if (markers.length === 0) {
    L.push('_기록된 단계 표시가 없다._', '');
  } else {
    for (const m of markers) {
      const t = `${Math.floor(m.sinceMs / 1000)}초`;
      L.push(m.kind === 'marker' ? `- **[${m.seq}] ${t} — 📌 ${m.note}**` : `- [${m.seq}] ${t} — 이동: ${m.url}`);
    }
    L.push('');
  }

  L.push('## 예약·요금 후보 엔드포인트', '');
  if (candidates.length === 0) {
    L.push('_후보 없음. 달력/모달이 JSON 이 아니라 HTML 로 오는지, 또는 아직 해당 화면까지 가지 않았는지 확인._', '');
  } else {
    for (const g of candidates) {
      L.push(`### ${g.method} ${g.pathname}`, '');
      L.push(`- 호스트: \`${g.host}\``);
      L.push(`- 호출 횟수: ${g.count} · 상태: ${[...g.statuses].join(', ')} · 응답형태: ${[...g.kinds].join(', ')}`);
      if (g.queryKeys.size) L.push(`- 쿼리 파라미터: ${[...g.queryKeys].map((k) => `\`${k}\``).join(', ')}`);
      if (g.bodyKeys.size) L.push(`- 요청 본문 키: ${[...g.bodyKeys].map((k) => `\`${k}\``).join(', ')}`);
      if (g.shapes.size) L.push(`- 응답 최상위 키: ${[...g.shapes].map((k) => `\`${k}\``).join(', ')}`);
      if (g.hints.size) L.push(`- 신호: ${[...g.hints].join(' / ')}`);
      if (g.samples.length) L.push(`- 원문: ${g.samples.map((s) => `\`${s}\``).join(', ')}`);
      L.push('');
    }
  }

  L.push('## 전체 XHR/fetch 엔드포인트', '');
  L.push('| # | 메서드 | 경로 | 횟수 | 응답 | 쿼리/본문 키 |');
  L.push('|---|---|---|---|---|---|');
  for (const g of sorted) {
    const keys = [...g.queryKeys, ...g.bodyKeys].slice(0, 12).join(', ') || '—';
    L.push(`| ${g.firstSeq} | ${g.method} | \`${g.pathname}\` | ${g.count} | ${[...g.kinds].join('/')} | ${keys} |`);
  }
  L.push('');

  const docs = reqs.filter((e) => e.resourceType === 'document');
  if (docs.length) {
    L.push('## 페이지(HTML 문서) 요청', '');
    for (const d of docs) L.push(`- [${d.seq}] ${d.status} ${d.method} \`${d.url}\` ${Object.keys(d.query ?? {}).length ? `— 쿼리: ${Object.keys(d.query!).join(', ')}` : ''}`);
    L.push('');
  }

  const fails = entries.filter((e) => e.kind === 'failed');
  if (fails.length) {
    L.push('## 실패한 요청', '');
    for (const f of fails) L.push(`- [${f.seq}] ${f.method} \`${f.url}\` — ${f.error}`);
    L.push('');
  }

  L.push('## 다음에 확인할 것 (CLAUDE.md §12)', '');
  L.push('- [ ] 달력 데이터가 JSON 으로 오는가? 온다면 월(yyyyMM)·동(건물)·박수를 어떤 파라미터로 넘기는가?');
  L.push('- [ ] 날짜 모달의 객실·요금 데이터가 JSON 으로 오는가? 옵션을 클릭해야만 요금이 오는가?');
  L.push('- [ ] 달력에서 `예약가능` 과 `마감` 은 실제로 어떤 텍스트/코드로 표시되는가?');
  L.push('- [ ] `잔여 객실 보기` 페이지가 한 숙소의 여러 동을 한 번에 보여주는가? 연박 조건을 받는가?');
  L.push('- [ ] 객실종류 체크박스가 URL 파라미터로 전달되는가?');
  L.push('- [ ] 로그인 상태를 판별할 수 있는 요소/쿠키 이름은 무엇인가?');
  L.push('');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────────────────────

/** --login: 자동으로 로그인하고 예약 화면까지 열어 준다. 그 다음은 사람이 직접 진행한다. */
async function autoLogin(page: Page, creds: { id: string; pw: string }): Promise<void> {
  const cfg = RESORT.login;
  if (!cfg) throw new Error(`${RESORT.name} 는 아직 자동 로그인을 지원하지 않습니다. --login 없이 실행하고 직접 로그인하세요.`);
  const SEL = cfg.sel;

  console.log('  로그인 중…');
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  const idBox = page.locator(SEL.loginId);
  const pwBox = page.locator(SEL.loginPw);
  await idBox.waitFor({ state: 'visible', timeout: 20_000 });
  await idBox.click();
  await idBox.pressSequentially(creds.id, { delay: 40 });
  await sleep(400);
  await pwBox.click();
  await pwBox.pressSequentially(creds.pw, { delay: 40 });
  await sleep(400);

  const submit = page.locator(SEL.loginSubmit).first();
  if (await submit.count()) await submit.click();
  else await pwBox.press('Enter');

  await page.waitForURL((u) => !u.pathname.includes('/member/login'), { timeout: 30_000 }).catch(() => {});
  await sleep(2000);
  if (cfg.afterUrl) {
    console.log('  로그인 완료. 예약 화면을 엽니다…');
    await page.goto(cfg.afterUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await sleep(1500);
  } else {
    console.log('  아이디·비밀번호까지 입력했습니다.');
    console.log('  추가 입력(회원권 비밀번호 등)이 있으면 브라우저 화면에서 직접 진행하세요.');
  }
}

/** 기록(entries.ndjson)만 가지고 보고서를 다시 만든다. 실행 중 터미널이 강제 종료된 경우 복구용. */
function rebuildReport(dir: string): void {
  const target = path.resolve(process.cwd(), dir);
  const nd = path.join(target, 'entries.ndjson');
  if (!fs.existsSync(nd)) {
    console.error(`entries.ndjson 을 찾을 수 없습니다: ${nd}`);
    process.exit(1);
  }
  OUT_DIR = target;
  BODY_DIR = path.join(target, 'bodies');
  NDJSON = nd;
  runId = path.basename(target);
  for (const line of fs.readFileSync(nd, 'utf8').split('\n')) {
    if (line.trim()) entries.push(JSON.parse(line) as Entry);
  }
  if (entries.length === 0) {
    console.error('기록이 비어 있습니다.');
    process.exit(1);
  }
  let meta = { browser: '(기록에서 재생성)', userAgent: '(기록 없음)', startUrl: '(기록 없음)' };
  const metaFile = path.join(target, 'meta.json');
  if (fs.existsSync(metaFile)) {
    try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaFile, 'utf8')) }; } catch { /* 무시 */ }
  }
  startedAt = new Date(entries[0].at);
  const endedAt = new Date(entries[entries.length - 1].at);
  const out = path.join(target, 'report.md');
  fs.writeFileSync(out, buildReport({ ...meta, endedAt }));
  console.log(`보고서를 다시 만들었습니다: ${path.relative(process.cwd(), out)}`);
}

async function main(): Promise<void> {
  const reportOnly = process.argv.find((a) => a.startsWith('--report-only='))?.slice('--report-only='.length);
  if (reportOnly) { rebuildReport(reportOnly); return; }

  fs.mkdirSync(BODY_DIR, { recursive: true });

  console.log('');
  console.log(`  ANC 리조트 — Phase 0 ${RESORT.name} 탐색`);
  console.log('  ────────────────────────────────────────────────────────');
  console.log(DO_LOGIN
    ? '  로그인까지는 자동으로 합니다. 그 다음부터 직접 진행하세요.'
    : '  이 창은 아무것도 자동으로 누르지 않습니다. 직접 진행하세요.');
  console.log(DO_LOGIN ? '  1) (자동) 로그인 → 예약 화면' : '  1) 브라우저에서 로그인');
  console.log('  2) 숙소를 고르고 예약가능 현황(달력)까지 들어가기');
  console.log('  3) 날짜를 하나 골라 객실 목록 보기');
  console.log('  4) 객실을 하나 골라 회원가(금액)가 나오는 화면까지');
  console.log('  5) 연박(2박)으로도 한 번 조회해 보기');
  console.log('');
  console.log('  ⚠ 예약하기 / 대기신청 / 취소 버튼은 절대 누르지 마세요. 이 도구는 읽기 전용입니다.');
  console.log('');
  console.log('  터미널에 문장 + Enter  →  그 시점을 기록에 표시 (예: "달력 화면 도착")');
  console.log('  터미널에 q + Enter     →  브라우저 닫고 보고서 작성');
  console.log('  ────────────────────────────────────────────────────────');
  console.log('');

  // 자격은 브라우저를 띄우기 전에 받는다. 빈 창이 떠 있는 동안 닫아 버리는 사고를 막는다.
  if (DO_LOGIN && !RESORT.login) {
    console.error(`\n  ${RESORT.name} 는 아직 자동 로그인을 지원하지 않습니다.`);
    console.error('  --login 을 빼고 실행한 뒤, 브라우저에서 직접 로그인하세요. 기록은 똑같이 남습니다.\n');
    process.exit(1);
  }
  const creds = DO_LOGIN ? await getSonoCredentials() : null;

  let browser: Browser;
  let browserLabel: string;
  try {
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized'] });
    browserLabel = `Chrome (channel) ${browser.version()}`;
  } catch {
    browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
    browserLabel = `Playwright Chromium ${browser.version()}`;
  }

  const context: BrowserContext = await browser.newContext({
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });

  context.on('response', (res) => { void onResponse(res).catch(() => {}); });
  context.on('requestfailed', (req) => {
    const url = req.url();
    if (isNoise(url) || IGNORED_RESOURCE_TYPES.has(req.resourceType())) return;
    const n = ++seq;
    const now = new Date();
    push({ kind: 'failed', seq: n, at: now.toISOString(), sinceMs: now.getTime() - startedAt.getTime(), method: req.method(), url: url.split('?')[0], error: req.failure()?.errorText ?? 'unknown' });
  });
  context.on('page', (p) => attachPage(p));

  const page = await context.newPage();
  attachPage(page);

  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '(확인 실패)');
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify({ runId, startUrl, browser: browserLabel, userAgent, startedAt: startedAt.toISOString() }, null, 2));

  console.log(`  브라우저: ${browserLabel}`);
  console.log(`  User-Agent: ${userAgent}`);
  console.log('');

  try {
    if (creds) {
      await autoLogin(page, creds);
    } else {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
  } catch (e) {
    console.log(`  ⚠ 여는 데 실패했습니다: ${(e as Error).message}`);
    console.log('    브라우저 주소창에 직접 주소를 입력해 계속하셔도 됩니다.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

  const finish = async (why: string): Promise<void> => {
    if (finished) return;
    finished = true;
    console.log(`\n  기록을 정리합니다… (${why})`);
    rl.close();
    try { await browser.close(); } catch { /* 이미 닫혔을 수 있다 */ }

    const report = buildReport({ browser: browserLabel, userAgent, startUrl, endedAt: new Date() });
    const reportPath = path.join(OUT_DIR, 'report.md');
    fs.writeFileSync(reportPath, report);

    const reqCount = entries.filter((e) => e.kind === 'request').length;
    console.log('');
    console.log('  ────────────────────────────────────────────────────────');
    console.log(`  요청 ${reqCount}건 기록`);
    console.log(`  보고서:  ${path.relative(process.cwd(), reportPath)}`);
    console.log(`  원문:    ${path.relative(process.cwd(), BODY_DIR)}/`);
    console.log(`  원자료:  ${path.relative(process.cwd(), NDJSON)}`);
    console.log('  ────────────────────────────────────────────────────────');
    console.log('');
    process.exit(0);
  };

  rl.on('line', (line) => {
    const t = line.trim();
    if (t === 'q' || t === 'quit' || t === '종료') { void finish('사용자 종료'); return; }
    if (!t) return;
    const n = ++seq;
    const now = new Date();
    push({ kind: 'marker', seq: n, at: now.toISOString(), sinceMs: now.getTime() - startedAt.getTime(), note: t });
    console.log(`[${String(n).padStart(4, '0')}] 📌 ${t}`);
  });

  rl.on('SIGINT', () => { void finish('Ctrl+C'); });
  process.on('SIGINT', () => { void finish('Ctrl+C'); });
  process.on('SIGTERM', () => { void finish('SIGTERM'); });
  process.on('SIGHUP', () => { void finish('터미널 종료') });
  browser.on('disconnected', () => { void finish('브라우저 창이 닫힘'); });
}

main().catch((err) => {
  console.error('\n  실패:', (err as Error).message);
  if (/has been closed|Target page/i.test((err as Error).message)) {
    console.error('  → 브라우저 창이 닫혔습니다. 실행이 끝날 때까지 창을 그대로 두세요.');
  }
  process.exit(1);
});
