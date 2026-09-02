/**
 * ANC 리조트 예약현황 — 사내 게시판 삽입용 화면
 *
 * - Firestore 에서 기본정보(숙소 트리·객실)와 마지막 조회 결과를 읽는다.
 * - [조회] 를 누르면 봇 서비스를 호출해 그 시점 현황을 가져온다.
 * - 예약·취소는 하지 않는다. 보기만 하는 화면이다.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  collection, doc, getDoc, getDocs, getFirestore, query, where,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

// ─────────────────────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────────────────────

const BOT_URL = 'https://anc-resort-bot-551643700321.asia-northeast3.run.app';

const FIREBASE = {
  apiKey: 'AIzaSyCPhW08fL2JFszxGCziHNAvaq9N6gxck_4',
  authDomain: 'anc-resort.firebaseapp.com',
  projectId: 'anc-resort',
  storageBucket: 'anc-resort.firebasestorage.app',
  messagingSenderId: '551643700321',
  appId: '1:551643700321:web:ca294732d03257f4fbde20',
};

/** 상태 줄 안내 문구. 담당자가 바뀌면 여기만 고친다. */
const CONTACT_NOTE = '회원가 기준 · 예약은 담당자 김사랑 Pro에게 요청하세요';

const STATUS_TEXT = {
  open: '확인',
  available: '예약가능',
  closing: '마감임박',
  waitlist: '예약대기',
  full: '마감',
  partial: '연박 불가',
  unknown: '확인 필요',
};

const ERROR_TEXT = {
  script: '화면을 그리는 중 문제가 생겼습니다. 새로고침해 주세요.',
  auth_failed: '지금은 확인이 안 됩니다. 담당자에게 문의하세요.',
  parse_failed: '지금은 확인이 안 됩니다. 담당자에게 문의하세요.',
  maintenance: '리조트 사이트 점검 중입니다.',
  blocked: '지금은 확인이 안 됩니다. 담당자에게 문의하세요.',
  timeout: '응답이 너무 늦어 중단했습니다. [조회] 를 한 번 더 눌러주세요.',
  rate_limited: '조회가 잠시 막혔습니다. 담당자에게 문의하세요.',
  unauthorized: '이 화면의 주소가 올바르지 않습니다. 담당자에게 문의하세요.',
  network: '연결이 되지 않습니다. 잠시 후 다시 눌러주세요.',
};

/** 좁은 화면(포털 위젯 등)에서 쓸 짧은 표기 */
const STATUS_SHORT = {
  open: '확인',
  available: '가능', closing: '임박', waitlist: '대기', full: '마감', partial: '일부', unknown: '?',
};

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

// ─────────────────────────────────────────────────────────────────────────────
// 준비
// ─────────────────────────────────────────────────────────────────────────────

const db = getFirestore(initializeApp(FIREBASE));
const token = new URLSearchParams(location.search).get('t') ?? '';

const $ = (id) => document.getElementById(id);
const el = {
  picks: $('picks'), nights: $('nights'), search: $('search'), status: $('status'),
  calSection: $('calendarSection'), calendar: $('calendar'), monthLabel: $('monthLabel'),
  prevMonth: $('prevMonth'), nextMonth: $('nextMonth'),
  detailSection: $('detailSection'), detailTitle: $('detailTitle'), detailFetched: $('detailFetched'),
  refreshDetail: $('refreshDetail'), buildings: $('buildings'), rooms: $('rooms'), foot: $('foot'),
  lightbox: $('lightbox'), lbImg: $('lbImg'), lbPrev: $('lbPrev'), lbNext: $('lbNext'),
  lbClose: $('lbClose'), lbCount: $('lbCount'), pageSub: $('pageSub'),
  legend: $('legend'), calHint: $('calHint'), footClosing: $('footClosing'),
};

// 게시글 안에 끼워 넣은 경우(iframe)에는 머리말을 감춘다. 새 창으로 연 경우에만 보인다.
const standalone = window.self === window.top;

const state = {
  resorts: [],          // [{id, name}]
  resortId: null,
  nodes: [],            // 전체 트리
  levels: [],           // 각 단계에서 고른 nodeId
  nodeId: null,         // 선택된 동(bookable)
  month: null,          // "202610"
  nights: 1,
  checkin: null,        // "2026-10-02"
  days: {},             // 달력
  calFetchedAt: null,
  detail: null,
  roomInfo: new Map(),  // roomId → 기본정보(정원·사진)
  busy: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// 날짜 도우미
// ─────────────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const ymOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const addDays = (isoStr, n) => { const d = parseIso(isoStr); d.setDate(d.getDate() + n); return iso(d); };
const won = (n) => `${n.toLocaleString('ko-KR')}원`;
const mdw = (isoStr) => { const d = parseIso(isoStr); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY[d.getDay()]})`; };
const clockOf = (v) => {
  const d = v?.toDate ? v.toDate() : new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// 표시
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

function baseStatus() {
  const when = state.calFetchedAt ? `마지막 조회 ${clockOf(state.calFetchedAt)} · ` : '';
  setStatus(`${when}${CONTACT_NOTE}`);
}

/** 게시판이 iframe 높이를 맞출 수 있도록 알려 준다. 지원하지 않으면 무시된다. */
function reportHeight() {
  const h = document.documentElement.scrollHeight;
  try { parent.postMessage({ type: 'anc-resort-height', height: h }, '*'); } catch { /* 무시 */ }
}
const ro = new ResizeObserver(reportHeight);
ro.observe(document.documentElement);

// ─────────────────────────────────────────────────────────────────────────────
// 봇 호출
// ─────────────────────────────────────────────────────────────────────────────

/** 조회 시간 제한. 이걸 두지 않으면 응답이 안 올 때 "조회 중…" 에서 영영 멈춘다. */
const CALL_TIMEOUT_MS = 60_000;

/** "조회 중…" 에 경과 시간을 붙여 살아 있다는 걸 보여준다. */
function startProgress() {
  const t0 = Date.now();
  const tick = () => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    const hint = sec >= 8 ? ' · 한동안 쓰지 않으면 준비에 20~30초 걸릴 수 있습니다' : '';
    setStatus(`조회 중… ${sec}초${hint}`, 'loading');
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

async function callBot(path, body) {
  if (!token) throw Object.assign(new Error('no token'), { code: 'unauthorized' });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BOT_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (e) {
    throw Object.assign(new Error('network'), { code: e?.name === 'AbortError' ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? 'error'), { code: json.error ?? 'parse_failed' });
  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// 선택 드롭다운 (계층 깊이를 고정하지 않는다)
// ─────────────────────────────────────────────────────────────────────────────

const childrenOf = (parentId) =>
  state.nodes
    .filter((n) => n.resortId === state.resortId && n.parentId === parentId)
    .sort((a, b) => a.order - b.order);

function addPick(labelText, options, selectedId, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'pick';
  const label = document.createElement('span');
  label.className = 'pick-label';
  label.textContent = labelText;
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    if (o.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  wrap.append(label, sel);
  el.picks.appendChild(wrap);
}

function renderPicks() {
  el.picks.innerHTML = '';
  state.nodeId = null;

  // 리조트가 둘 이상일 때만 리조트 단계를 그린다.
  if (state.resorts.length > 1) {
    addPick('리조트', state.resorts, state.resortId, (v) => {
      state.resortId = v;
      state.levels = [];
      state.checkin = null;
      state.detail = null;
      el.detailSection.hidden = true;
      renderPicks();
      void afterPickChange();
    });
  }

  let parentId = null;
  for (let depth = 0; depth < 8; depth++) {
    const options = childrenOf(parentId);
    if (options.length === 0) break;

    const chosen = state.levels[depth] && options.some((o) => o.id === state.levels[depth])
      ? state.levels[depth]
      : options[0].id;
    state.levels[depth] = chosen;

    addPick(
      { region: '지역', property: '숙소', building: '동' }[options[0].level] ?? '선택',
      options, chosen,
      (v) => {
        state.levels[depth] = v;
        state.levels.length = depth + 1;      // 아래 단계는 다시 고른다
        renderPicks();
      },
    );

    const node = options.find((o) => o.id === chosen);
    if (node?.bookable) state.nodeId = node.id;
    parentId = chosen;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 달력
// ─────────────────────────────────────────────────────────────────────────────

const thisMonth = () => ymOf(new Date());

/** 리조트를 바꾸면 그 리조트의 기본정보와 저장된 달력을 다시 읽는다 (사이트 접근 없음) */
async function afterPickChange() {
  await loadRoomInfo(state.nodeId);
  await loadCalendar({ force: false });
}

/** 범례는 그 달에 실제로 나온 상태만 보여준다. 리조트마다 상태 종류가 다르다. */
function renderLegend() {
  const order = ['available', 'open', 'closing', 'waitlist', 'full', 'unknown'];
  const present = new Set(Object.values(state.days));

  // 배포 중에 HTML 과 JS 판이 어긋나면 요소가 없을 수 있다.
  // 범례는 곁가지이므로, 없으면 조용히 넘어간다. 이것 때문에 달력 전체가 안 그려지면 안 된다.
  if (el.legend) {
    el.legend.innerHTML = '';
    for (const st of order) {
      if (!present.has(st)) continue;
      const span = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = `dot ${st}`;
      span.append(dot, document.createTextNode(STATUS_TEXT[st] ?? st));
      el.legend.appendChild(span);
    }
  }

  // '마감임박' 설명은 그 상태가 실제로 나오는 리조트에서만 보여준다.
  if (el.footClosing) el.footClosing.hidden = !present.has('closing');

  // 아난티처럼 날짜별 잔여를 주지 않는 곳은 그렇다고 알려 준다.
  const openOnly = present.has('open');
  if (el.calHint) {
    el.calHint.hidden = !openOnly;
    if (openOnly) {
      el.calHint.textContent = '이 리조트는 날짜별 잔여를 미리 알려주지 않습니다. 날짜를 누르면 객실별 예약 가능 여부와 요금이 나옵니다.';
    }
  }
}

function renderCalendar() {
  const y = Number(state.month.slice(0, 4));
  const m = Number(state.month.slice(4, 6));
  el.monthLabel.textContent = `${y}년 ${m}월`;
  el.prevMonth.disabled = state.month <= thisMonth();

  const first = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0).getDate();
  const todayIso = iso(new Date());

  const stay = new Set();
  if (state.checkin) {
    for (let i = 0; i < state.nights; i++) stay.add(addDays(state.checkin, i));
  }

  el.calendar.innerHTML = '';
  for (let i = 0; i < first.getDay(); i++) {
    const blank = document.createElement('div');
    blank.className = 'cell empty';
    el.calendar.appendChild(blank);
  }

  for (let day = 1; day <= lastDay; day++) {
    const dateIso = `${y}-${pad(m)}-${pad(day)}`;
    const dow = new Date(y, m - 1, day).getDay();
    const status = state.days[dateIso];

    const cell = document.createElement(status ? 'button' : 'div');
    cell.className = ['cell', dow === 0 ? 'sun' : '', dow === 6 ? 'sat' : '',
      dateIso < todayIso ? 'past' : '', status ? 'pickable' : '',
      state.checkin === dateIso ? 'selected' : '', stay.has(dateIso) ? 'in-stay' : '']
      .filter(Boolean).join(' ');

    const num = document.createElement('span');
    num.className = 'd';
    num.textContent = String(day);
    cell.appendChild(num);

    if (status) {
      const badge = document.createElement('span');
      badge.className = `badge ${status}`;
      badge.textContent = STATUS_TEXT[status] ?? status;
      badge.dataset.short = STATUS_SHORT[status] ?? '?';
      cell.appendChild(badge);
      cell.addEventListener('click', () => pickDate(dateIso));
    }
    el.calendar.appendChild(cell);
  }
  renderLegend();
  el.calSection.hidden = false;
}

/**
 * force=false 면 **저장된 결과만** 보여준다. 리조트 사이트에 가지 않는다.
 * 게시글을 여는 것만으로 사이트에 요청이 가면 안 된다 (CLAUDE.md §2).
 * 사이트 접근은 [조회] 를 눌렀을 때(force=true)만 일어난다.
 */
async function loadCalendar({ force }) {
  const nodeId = state.nodeId;
  if (!nodeId) return;

  if (!force) {
    const snap = await getDoc(doc(db, 'snapshots', `${nodeId}_${state.month}`)).catch(() => null);
    if (snap?.exists()) {
      const d = snap.data();
      state.days = d.days ?? {};
      state.calFetchedAt = d.fetchedAt;
      renderCalendar();
      baseStatus();
    } else {
      state.days = {};
      state.calFetchedAt = null;
      renderCalendar();
      setStatus('저장된 결과가 없습니다. [조회] 를 눌러 확인하세요.');
    }
    return;
  }

  state.busy = true;
  const stop = startProgress();
  try {
    const r = await callBot('/calendar', { resortId: state.resortId, nodeId, yyyyMM: state.month });
    state.days = r.days ?? {};
    state.calFetchedAt = r.fetchedAt;
    renderCalendar();
    baseStatus();
  } catch (e) {
    // 다시 그리다 또 터지면 오류 문구조차 못 띄운다. 그리기는 실패해도 넘어간다.
    try { renderCalendar(); } catch { /* 무시 */ }
    setStatus(ERROR_TEXT[e.code] ?? ERROR_TEXT.script, 'error');
  } finally {
    stop();
    state.busy = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 상세
// ─────────────────────────────────────────────────────────────────────────────

async function pickDate(dateIso) {
  state.checkin = dateIso;
  renderCalendar();
  await loadDetail({ force: false });
  el.detailSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * 날짜를 누르는 것은 "이 날 보여줘" 라는 명시적 요청이므로,
 * 저장된 결과가 없으면 그때는 사이트를 조회한다. 화면을 여는 것과는 다르다.
 */
async function loadDetail({ force }) {
  const { nodeId, checkin, nights } = state;
  if (!nodeId || !checkin) return;

  if (!force) {
    const snap = await getDoc(doc(db, 'details', `${nodeId}_${checkin}_${nights}`)).catch(() => null);
    if (snap?.exists()) {
      state.detail = snap.data();
      await renderDetail();
      return;
    }
  }

  const stop = startProgress();
  try {
    state.detail = await callBot('/detail', { resortId: state.resortId, nodeId, checkin, nights });
    await renderDetail();
    baseStatus();
  } catch (e) {
    if (state.detail) { try { await renderDetail(); } catch { /* 무시 */ } }
    setStatus(ERROR_TEXT[e.code] ?? ERROR_TEXT.parse_failed, 'error');
  } finally {
    stop();
  }
}

/** 선택한 동의 객실 기본정보(정원·사진)를 받아 둔다 */
async function loadRoomInfo(nodeId) {
  state.roomInfo = new Map();
  const snap = await getDocs(query(collection(db, 'rooms'), where('nodeId', '==', nodeId))).catch(() => null);
  for (const d of snap?.docs ?? []) state.roomInfo.set(d.id, d.data());
}

function capacityText(info, room) {
  if (!info) {
    const c = room?.siteRef?.capacity;
    return c ? `기준 ${c}인` : '';
  }
  if (info.capacityAmbiguous && info.capacityText) return info.capacityText;
  if (info.capacityStd == null) return info.capacityText ?? '';
  const max = info.capacityMax ?? info.capacityStd;
  return max > info.capacityStd ? `기준 ${info.capacityStd}인 / 최대 ${max}인` : `기준 ${info.capacityStd}인`;
}

async function renderDetail() {
  const d = state.detail;
  const checkout = addDays(state.checkin, state.nights);
  el.detailTitle.textContent = `${mdw(state.checkin)} → ${mdw(checkout)} · ${state.nights}박`;
  el.detailFetched.textContent = d?.fetchedAt ? `조회 ${clockOf(d.fetchedAt)}` : '';

  // 동별 잔여 (형제 동이 둘 이상일 때만)
  const buildings = d?.buildings ?? [];
  el.buildings.hidden = buildings.length === 0;
  el.buildings.innerHTML = '';
  if (buildings.length) {
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = `동별 잔여 · ${state.nights}박 연박 기준`;
    el.buildings.appendChild(label);
    for (const b of buildings) {
      const chip = document.createElement('button');
      const on = b.nodeId === state.nodeId;
      chip.className = `chip${on ? ' on' : ''}`;
      chip.textContent = `${b.name} ${b.remaining}실`;
      if (!on) chip.addEventListener('click', () => switchBuilding(b.nodeId));
      el.buildings.appendChild(chip);
    }
  }

  // 객실 목록 — path 상위로 묶고, 마지막 두 단계를 항목명으로
  el.rooms.innerHTML = '';
  const rooms = d?.rooms ?? [];
  if (rooms.length === 0) {
    el.rooms.innerHTML = '<p class="muted">표시할 객실이 없습니다.</p>';
    el.detailSection.hidden = false;
    return;
  }

  const groups = new Map();
  for (const r of rooms) {
    const key = (r.path ?? []).slice(0, -2).join(' · ') || '객실';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const buildingName = state.nodes.find((n) => n.id === state.nodeId)?.name ?? '';

  for (const [key, list] of groups) {
    const caps = [...new Set(list.map((r) => capacityText(state.roomInfo.get(r.roomId), r)).filter(Boolean))];
    const section = document.createElement('div');
    section.className = 'group';

    const head = document.createElement('div');
    head.className = 'group-head';
    head.textContent = [buildingName, key].filter(Boolean).join(' · ');
    if (caps.length === 1) {
      const cap = document.createElement('span');
      cap.className = 'cap';
      cap.textContent = ` · ${caps[0]}`;
      head.appendChild(cap);
    }
    section.appendChild(head);

    for (const r of list) section.appendChild(renderRoom(r, caps.length === 1));
    el.rooms.appendChild(section);
  }
  el.detailSection.hidden = false;
}

function renderRoom(r, capInHeader) {
  const info = state.roomInfo.get(r.roomId);
  const images = info?.images ?? [];

  const row = document.createElement('div');
  row.className = 'room';

  if (images.length) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = images[0];
    img.alt = r.name ?? '';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(images, 0));
    row.appendChild(img);
  } else {
    const box = document.createElement('div');
    box.className = 'thumb none';
    row.appendChild(box);
  }

  const main = document.createElement('div');
  main.className = 'room-main';

  const name = document.createElement('div');
  name.className = 'room-name';
  name.textContent = (r.path ?? []).slice(-2).join(' · ') || r.name || '';
  const badge = document.createElement('span');
  badge.className = `badge ${r.status}`;
  badge.textContent = STATUS_TEXT[r.status] ?? r.status;
  badge.style.marginLeft = '6px';
  name.appendChild(badge);
  main.appendChild(name);

  const subs = [];
  if (!capInHeader) { const c = capacityText(info, r); if (c) subs.push(c); }
  if (info?.areaText) subs.push(info.areaText);
  if (r.status === 'partial') {
    subs.push(r.availableNights?.length
      ? `${r.availableNights.map((n) => `${Number(n.slice(8))}일`).join(', ')}만 가능`
      : '연박 불가');
  }
  if (r.waitCount) subs.push(`대기 ${r.waitCount}`);
  if (r.siteRef?.remaining != null) subs.push(`잔여 ${r.siteRef.remaining}실`);
  if (r.status === 'full' && r.siteRef?.reason) subs.push(r.siteRef.reason);
  if (subs.length) {
    const sub = document.createElement('div');
    sub.className = 'room-sub';
    sub.textContent = subs.join(' · ');
    main.appendChild(sub);
  }
  row.appendChild(main);

  const price = document.createElement('div');
  price.className = 'room-price';
  const total = document.createElement('div');
  total.className = 'price-total';
  total.textContent = r.total == null ? '—' : won(r.total);
  price.appendChild(total);

  const nightsPriced = r.perNight?.length ?? 0;
  if (nightsPriced) {
    const lines = document.createElement('div');
    lines.className = 'price-lines';
    if (nightsPriced !== state.nights) {
      const note = document.createElement('div');
      note.textContent = `${nightsPriced}박 기준`;
      lines.appendChild(note);
    }
    if (nightsPriced > 1) {
      for (const n of r.perNight) {
        const line = document.createElement('div');
        line.textContent = `${Number(n.date.slice(5, 7))}/${Number(n.date.slice(8))} ${won(n.final)}`;
        if (n.discount) {
          const dc = document.createElement('span');
          dc.className = 'dc';
          dc.textContent = ` (${won(n.discount)} 할인)`;
          line.appendChild(dc);
        }
        lines.appendChild(line);
      }
    } else if (r.perNight[0]?.discount) {
      const line = document.createElement('div');
      line.className = 'dc';
      line.textContent = `원가 ${won(r.perNight[0].base)} · ${won(r.perNight[0].discount)} 할인`;
      lines.appendChild(line);
    }
    if (lines.childElementCount) price.appendChild(lines);
  }
  row.appendChild(price);
  return row;
}

async function switchBuilding(nodeId) {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  // 드롭다운 선택을 그 동으로 맞춘다
  const chain = [];
  for (let cur = node; cur; cur = state.nodes.find((n) => n.id === cur.parentId)) chain.unshift(cur.id);
  state.levels = chain;
  renderPicks();
  await loadRoomInfo(nodeId);
  await loadCalendar({ force: false });
  await loadDetail({ force: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// 사진 확대
// ─────────────────────────────────────────────────────────────────────────────

let lb = { list: [], i: 0 };

function openLightbox(list, i) {
  lb = { list, i };
  showLightbox();
  el.lightbox.hidden = false;
}
function showLightbox() {
  el.lbImg.src = lb.list[lb.i];
  el.lbCount.textContent = lb.list.length > 1 ? `${lb.i + 1} / ${lb.list.length}` : '';
  el.lbPrev.hidden = el.lbNext.hidden = lb.list.length < 2;
}
el.lbClose.addEventListener('click', () => { el.lightbox.hidden = true; });
el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox) el.lightbox.hidden = true; });
el.lbPrev.addEventListener('click', () => { lb.i = (lb.i - 1 + lb.list.length) % lb.list.length; showLightbox(); });
el.lbNext.addEventListener('click', () => { lb.i = (lb.i + 1) % lb.list.length; showLightbox(); });
document.addEventListener('keydown', (e) => {
  if (el.lightbox.hidden) return;
  if (e.key === 'Escape') el.lightbox.hidden = true;
  if (e.key === 'ArrowLeft') el.lbPrev.click();
  if (e.key === 'ArrowRight') el.lbNext.click();
});

// ─────────────────────────────────────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────────────────────────────────────

el.search.addEventListener('click', async () => {
  state.checkin = null;
  state.detail = null;
  el.detailSection.hidden = true;
  await loadRoomInfo(state.nodeId);
  await loadCalendar({ force: true });
});

el.nights.addEventListener('change', async () => {
  state.nights = Number(el.nights.value);
  renderCalendar();
  if (state.checkin) await loadDetail({ force: false });
});

el.prevMonth.addEventListener('click', async () => {
  const d = parseIso(`${state.month.slice(0, 4)}-${state.month.slice(4, 6)}-01`);
  d.setMonth(d.getMonth() - 1);
  if (ymOf(d) < thisMonth()) return;
  state.month = ymOf(d);
  await loadCalendar({ force: false });
});

el.nextMonth.addEventListener('click', async () => {
  const d = parseIso(`${state.month.slice(0, 4)}-${state.month.slice(4, 6)}-01`);
  d.setMonth(d.getMonth() + 1);
  state.month = ymOf(d);
  await loadCalendar({ force: false });
});

el.refreshDetail.addEventListener('click', () => loadDetail({ force: true }));

async function start() {
  state.month = thisMonth();
  state.nights = Number(el.nights.value);

  try {
    const [resortSnap, nodeSnap] = await Promise.all([
      getDocs(collection(db, 'resorts')),
      getDocs(collection(db, 'nodes')),
    ]);
    state.resorts = resortSnap.docs
      .map((d) => ({ id: d.id, name: d.data().name ?? d.id, active: d.data().active }))
      .filter((r) => r.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    state.nodes = nodeSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.active !== false);
    state.resortId = state.resorts[0]?.id ?? 'sono';
  } catch {
    setStatus('기본정보를 불러오지 못했습니다. 담당자에게 문의하세요.', 'error');
    return;
  }
  if (state.nodes.length === 0) {
    setStatus('등록된 숙소가 없습니다. 담당자에게 문의하세요.', 'error');
    return;
  }

  renderPicks();
  // 제목은 항상 보인다. 설명 줄은 자리를 차지하므로 새 창으로 열었을 때만 보인다.
  if (el.pageSub) el.pageSub.hidden = !standalone;

  if (!token) {
    setStatus('이 화면의 주소가 올바르지 않습니다. 담당자에게 문의하세요.', 'error');
  } else {
    baseStatus();
  }

  await loadRoomInfo(state.nodeId);
  await loadCalendar({ force: false });   // 저장된 마지막 결과만 보여준다 (사이트 접근 없음)
  reportHeight();
}

start();
