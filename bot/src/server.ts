/**
 * 봇 HTTP 서비스 (CLAUDE.md §8)
 *
 *   POST /calendar  { resortId, nodeId, yyyyMM }            → { days, fetchedAt }
 *   POST /detail    { resortId, nodeId, checkin, nights }   → { buildings, rooms, fetchedAt }
 *   GET  /health                                            → { ok, sessions }
 *
 * 모든 조회 요청은 Authorization: Bearer <boardToken> 이 필요하다.
 * 읽기 전용이며, 성공한 결과는 Firestore 에 마지막 결과로 남긴다.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import Holidays from 'date-holidays';
import { getStorage } from 'firebase-admin/storage';

import { ananttiAdapter } from './adapters/anantti.ts';
import { hanwhaAdapter } from './adapters/hanwha.ts';
import { sonoAdapter } from './adapters/sono.ts';
import { AdapterError, type AdapterErrorCode, type Node, type ResortAdapter, type ResortId } from './adapters/types.ts';
import { closeAll, getContext, getLoginCount } from './browser.ts';
import { getChildNodes, getNode, getPortalContent, removePortalContent, savePortalContent, writeDetail, writeSnapshot } from './store.ts';

const PORT = Number(process.env.PORT ?? 8080);

/** 게시판 토큰. Secret Manager 가 BOARD_TOKEN 으로 넣어 준다. */
const BOARD_TOKEN = process.env.BOARD_TOKEN ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_SESSION_KEY = process.env.SESSION_KEY || BOARD_TOKEN;
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const adminLoginFailures = new Map<string, { count: number; resetAt: number }>();
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_LIMIT = 5;

/** CORS 허용 출처. 쉼표로 여러 개. 비우면 모두 거부한다. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 한 요청의 상한 (CLAUDE.md §7.5) */
const REQUEST_TIMEOUT_MS = 30_000;

/** 같은 조회를 2초 안에 다시 부르면 직전 결과를 그대로 준다 (CLAUDE.md §7.2) */
const REPEAT_WINDOW_MS = 2_000;

const adapters: Record<string, ResortAdapter> = { sono: sonoAdapter, anantti: ananttiAdapter, hanwha: hanwhaAdapter };

/** 오류 코드 → HTTP 상태 */
const HTTP_STATUS: Record<AdapterErrorCode, number> = {
  auth_failed: 502,
  parse_failed: 502,
  maintenance: 503,
  blocked: 503,
  timeout: 504,
  rate_limited: 429,
};

// ─────────────────────────────────────────────────────────────────────────────
// 같은 요청 합치기
// ─────────────────────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();
const recent = new Map<string, { at: number; value: unknown }>();

async function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const fresh = recent.get(key);
  if (fresh && Date.now() - fresh.at < REPEAT_WINDOW_MS) return fresh.value as T;

  const running = inFlight.get(key);
  if (running) return running as Promise<T>;

  const p = (async () => {
    try {
      const value = await fn();
      recent.set(key, { at: Date.now(), value });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new AdapterError('timeout', '조회가 30초를 넘겼습니다.')), REQUEST_TIMEOUT_MS),
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 요청 처리
// ─────────────────────────────────────────────────────────────────────────────

function authorized(req: http.IncomingMessage): boolean {
  if (!BOARD_TOKEN) return false;                     // 토큰 미설정이면 전부 거부
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(BOARD_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAdminSession(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_KEY).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function adminAuthorized(req: http.IncomingMessage): boolean {
  if (!ADMIN_PASSWORD || !ADMIN_SESSION_KEY) return false;
  const token = String(req.headers['x-admin-session'] ?? '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_KEY).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try { return Number(JSON.parse(Buffer.from(payload, 'base64url').toString()).exp) > Date.now(); } catch { return false; }
}

function adminLoginKey(req: http.IncomingMessage): string {
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim();
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return allow
    ? {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Session',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Max-Age': '3600',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new AdapterError('parse_failed', '요청이 너무 큽니다.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AdapterError('parse_failed', '요청 본문이 JSON 이 아닙니다.');
  }
}

const cleanText = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
const CONTENT_BUCKET = 'anc-resort-rooms';
const NOTICE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const NOTICE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const NOTICE_IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function uploadNoticeImage(id: string, dataUrl: unknown): Promise<{ imageUrl: string; imagePath: string }> {
  const match = String(dataUrl ?? '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new AdapterError('parse_failed', '이미지는 PNG, JPG, WebP 형식만 등록할 수 있습니다.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > NOTICE_IMAGE_MAX_BYTES) throw new AdapterError('parse_failed', '이미지는 4MB 이하로 등록해 주세요.');
  const imagePath = `portal/notices/${id}/${crypto.randomUUID()}.${NOTICE_IMAGE_TYPES[match[1]]}`;
  const token = crypto.randomUUID();
  await getStorage().bucket(CONTENT_BUCKET).file(imagePath).save(bytes, {
    resumable: false,
    contentType: match[1],
    metadata: { cacheControl: 'public, max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
  });
  return { imagePath, imageUrl: `https://firebasestorage.googleapis.com/v0/b/${CONTENT_BUCKET}/o/${encodeURIComponent(imagePath)}?alt=media&token=${token}` };
}

async function deleteNoticeImage(imagePath?: string): Promise<void> {
  if (!imagePath?.startsWith('portal/notices/')) return;
  await getStorage().bucket(CONTENT_BUCKET).file(imagePath).delete({ ignoreNotFound: true });
}

type NoticeFile = { url: string; path: string; name: string; contentType: string; size: number };

async function uploadNoticeFile(body: Record<string, unknown>): Promise<NoticeFile> {
  const id = cleanText(body.id, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new AdapterError('parse_failed', '콘텐츠 ID가 올바르지 않습니다.');
  const contentType = cleanText(body.contentType, 120) || 'application/octet-stream';
  const inline = body.usage === 'inline';
  if (inline && !NOTICE_IMAGE_TYPES[contentType]) throw new AdapterError('parse_failed', '붙여넣기는 PNG, JPG, WebP 이미지만 지원합니다.');
  const encoded = String(body.data ?? '');
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new AdapterError('parse_failed', '파일 데이터가 올바르지 않습니다.');
  const bytes = Buffer.from(encoded, 'base64');
  const limit = inline ? NOTICE_IMAGE_MAX_BYTES : NOTICE_FILE_MAX_BYTES;
  if (!bytes.length || bytes.length > limit) throw new AdapterError('parse_failed', `파일은 ${limit / 1024 / 1024}MB 이하로 등록해 주세요.`);
  const originalName = cleanText(body.name, 180) || (inline ? '붙여넣은 이미지.png' : '첨부파일');
  const sourceExt = originalName.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1].toLowerCase();
  const ext = inline ? NOTICE_IMAGE_TYPES[contentType] : sourceExt || 'bin';
  const path = `portal/notices/${id}/${crypto.randomUUID()}.${ext}`;
  const token = crypto.randomUUID();
  await getStorage().bucket(CONTENT_BUCKET).file(path).save(bytes, {
    resumable: false, contentType,
    metadata: { cacheControl: 'private, max-age=3600', contentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${originalName.replace(/["\\]/g, '_')}"`, metadata: { firebaseStorageDownloadTokens: token } },
  });
  return { path, name: originalName, contentType, size: bytes.length, url: `https://firebasestorage.googleapis.com/v0/b/${CONTENT_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}` };
}

function noticeFiles(value: unknown, id: string): NoticeFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = entry as Partial<NoticeFile>;
    if (!item.path?.startsWith(`portal/notices/${id}/`) || !String(item.url).startsWith(`https://firebasestorage.googleapis.com/v0/b/${CONTENT_BUCKET}/o/`)) return [];
    return [{ url: String(item.url), path: item.path, name: cleanText(item.name, 180), contentType: cleanText(item.contentType, 120), size: Number(item.size) || 0 }];
  });
}

async function handleContentWrite(body: Record<string, unknown>): Promise<unknown> {
  const action = body.action === 'delete' ? 'delete' : 'save';
  const kind = body.kind === 'notice' ? 'notice' : body.kind === 'faq' ? 'faq' : null;
  const id = cleanText(body.id, 80);
  if (!kind || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new AdapterError('parse_failed', '콘텐츠 ID가 올바르지 않습니다.');
  const current = (await getPortalContent()).find((item) => item.id === id);
  if (action === 'delete') {
    await removePortalContent(id, kind);
    if (kind === 'notice') await Promise.all([current?.imagePath, ...(current?.inlineImages ?? []).map((x) => x.path), ...(current?.attachments ?? []).map((x) => x.path)].map(deleteNoticeImage));
    return { ok: true };
  }
  const title = cleanText(body.title, 160); const content = cleanText(body.body, 5000);
  const category = cleanText(body.category, 20);
  if (!title || !content || !category) throw new AdapterError('parse_failed', '구분, 제목, 내용을 모두 입력해 주세요.');
  const date = kind === 'notice' ? cleanText(body.date, 10) : '';
  if (kind === 'notice' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AdapterError('parse_failed', '등록일을 확인해 주세요.');
  const inlineImages = kind === 'notice' ? noticeFiles(body.inlineImages, id).map(({ url, path, name }) => ({ url, path, name })) : [];
  const attachments = kind === 'notice' ? noticeFiles(body.attachments, id) : [];
  const keptPaths = new Set([...inlineImages, ...attachments].map((x) => x.path));
  const oldPaths = [current?.imagePath, ...(current?.inlineImages ?? []).map((x) => x.path), ...(current?.attachments ?? []).map((x) => x.path)].filter((x): x is string => Boolean(x));
  await savePortalContent({ id, kind, category, title, body: content, ...(date ? { date } : {}), ...(kind === 'notice' ? { inlineImages, attachments } : {}) });
  await Promise.all(oldPaths.filter((path) => !keptPaths.has(path)).map(deleteNoticeImage));
  return { ok: true };
}

/** 조회 대상 노드를 찾아 검증한다. */
async function resolveNode(resortId: string, nodeId: string): Promise<{ adapter: ResortAdapter; node: Node }> {
  const adapter = adapters[resortId];
  if (!adapter) throw new AdapterError('parse_failed', `모르는 리조트입니다: ${resortId}`);
  const node = (await getNode(nodeId)) as Node | null;
  if (!node) throw new AdapterError('parse_failed', `노드를 찾을 수 없습니다: ${nodeId}`);
  if (node.resortId !== resortId) throw new AdapterError('parse_failed', '노드와 리조트가 맞지 않습니다.');
  if (!node.bookable) throw new AdapterError('parse_failed', '이 노드로는 조회할 수 없습니다.');
  return { adapter, node };
}

async function handleCalendar(body: Record<string, unknown>): Promise<unknown> {
  const resortId = String(body.resortId ?? '');
  const nodeId = String(body.nodeId ?? '');
  const yyyyMM = String(body.yyyyMM ?? '');
  if (!/^\d{6}$/.test(yyyyMM)) throw new AdapterError('parse_failed', 'yyyyMM 형식이 아닙니다.');

  return once(`cal:${resortId}:${nodeId}:${yyyyMM}`, async () => {
    const { adapter, node } = await resolveNode(resortId, nodeId);
    const ctx = await getContext(resortId as ResortId);
    await adapter.ensureSession(ctx);
    const result = await withTimeout(adapter.getCalendar(ctx, node, yyyyMM));
    await writeSnapshot(nodeId, yyyyMM, result.days, result.fetchedAt);
    return { days: result.days, fetchedAt: result.fetchedAt.toISOString() };
  });
}

async function handleDetail(body: Record<string, unknown>): Promise<unknown> {
  const resortId = String(body.resortId ?? '');
  const nodeId = String(body.nodeId ?? '');
  const checkin = String(body.checkin ?? '');
  const nights = Number(body.nights ?? 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin)) throw new AdapterError('parse_failed', 'checkin 은 yyyy-MM-dd 형식입니다.');
  if (!Number.isInteger(nights) || nights < 1 || nights > 2) throw new AdapterError('parse_failed', '박수는 1~2 입니다.');

  return once(`det:${resortId}:${nodeId}:${checkin}:${nights}`, async () => {
    const { adapter, node } = await resolveNode(resortId, nodeId);
    const ctx = await getContext(resortId as ResortId);
    await adapter.ensureSession(ctx);

    const detail = await withTimeout(adapter.getDetail(ctx, node, checkin, nights));

    // 형제 동이 둘 이상일 때만 동별 잔여를 붙인다 (CLAUDE.md §9 조건부 영역)
    let buildings = detail.buildings;
    if (adapter.getBuildingSummary && node.parentId) {
      const siblings = (await getChildNodes(node.parentId)).filter((n) => n.bookable);
      if (siblings.length > 1) {
        const parent = await getNode(node.parentId);
        if (parent) {
          buildings = await adapter
            .getBuildingSummary(ctx, parent as Node, checkin, nights)
            .catch(() => [] as typeof buildings);   // 부가 정보라 실패해도 본문은 준다
        }
      }
    }

    const payload = {
      buildings,
      rooms: detail.rooms,
    };
    await writeDetail(nodeId, checkin, nights, payload, detail.fetchedAt);
    return { ...payload, fetchedAt: detail.fetchedAt.toISOString() };
  });
}

/**
 * /health 는 토큰 없이 열려 있다. 그래서 **로그인을 유발해서는 안 된다.**
 * 아무나 반복 호출해 하루 로그인 상한을 태우고 계정 이상 알림을 부르는 일을 막는다.
 * 세션이 만료돼 있으면 expired 로만 알리고, 되살리는 일은 실제 조회 요청이 할 때 한다.
 */
async function handleHealth(): Promise<unknown> {
  const sessions: Record<string, string> = {};
  for (const [id, adapter] of Object.entries(adapters)) {
    try {
      const ctx = await getContext(id as ResortId);
      sessions[id] = (await adapter.sessionAlive(ctx)) ? 'alive' : 'expired';
    } catch (e) {
      sessions[id] = e instanceof AdapterError ? e.code : 'expired';
    }
  }
  const logins: Record<string, number> = {};
  for (const id of Object.keys(adapters)) logins[id] = await getLoginCount(id as ResortId);

  // Firestore 까지 닿는지 확인한다. 여기까지 왔으면 서비스 자체는 정상이다.
  let store = 'ok';
  try {
    await getNode('healthcheck');
  } catch (e) {
    store = `error: ${(e as Error).message.slice(0, 80)}`;
  }

  /**
   * `ok` 는 **서비스가 정상인가**를 뜻한다. 세션 만료는 장애가 아니다 —
   * 실제 조회가 들어오면 다시 로그인해서 스스로 회복한다(2026-09-02 확인).
   * 세션 상태는 참고용으로만 함께 준다.
   */
  return {
    ok: store === 'ok',
    store,
    sessions,
    loginsToday: logins,
    note: '세션이 expired 여도 조회는 자동으로 다시 로그인합니다. 첫 조회만 20초쯤 걸립니다.',
  };
}

function handleHolidays(year: number): unknown {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new AdapterError('parse_failed', '연도가 올바르지 않습니다.');
  const calendar = new Holidays('KR');
  const days = new Map<string, string>();
  const add = (date: string, name: string) => days.set(date, days.has(date) ? `${days.get(date)} · ${name}` : name);
  for (const holiday of calendar.getHolidays(year).filter((item) => item.type === 'public')) {
    const date = holiday.date.slice(0, 10); add(date, holiday.name);
    if (holiday.name === '설날' || holiday.name === '추석') {
      const center = new Date(`${date}T12:00:00Z`);
      for (const [offset, suffix] of [[-1, '연휴'], [1, '연휴']] as const) {
        const next = new Date(center); next.setUTCDate(next.getUTCDate() + offset); add(next.toISOString().slice(0, 10), `${holiday.name} ${suffix}`);
      }
    }
  }
  return { year, days: Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b))) };
}

// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const cors = corsHeaders(req.headers.origin);

  void (async () => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const path = (req.url ?? '/').split('?')[0];

    try {
      if (req.method === 'GET' && path === '/health') {
        send(res, 200, await handleHealth(), cors);
        return;
      }

      if (req.method === 'GET' && path === '/content') {
        if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }, cors); return; }
        send(res, 200, { items: await getPortalContent() }, cors);
        return;
      }

      if (req.method === 'GET' && path === '/holidays') {
        if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }, cors); return; }
        const year = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('year'));
        send(res, 200, handleHolidays(year), cors);
        return;
      }

      if (req.method === 'POST' && path === '/admin/login') {
        if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }, cors); return; }
        const key = adminLoginKey(req); const now = Date.now(); const failure = adminLoginFailures.get(key);
        if (failure && failure.resetAt > now && failure.count >= ADMIN_LOGIN_LIMIT) {
          send(res, 429, { error: 'too_many_attempts' }, cors); return;
        }
        const body = await readJson(req);
        if (!ADMIN_PASSWORD || !safeEqual(String(body.password ?? ''), ADMIN_PASSWORD)) {
          const current = failure && failure.resetAt > now ? failure : { count: 0, resetAt: now + ADMIN_LOGIN_WINDOW_MS };
          current.count++; adminLoginFailures.set(key, current);
          send(res, 401, { error: 'invalid_password' }, cors); return;
        }
        adminLoginFailures.delete(key);
        send(res, 200, { session: createAdminSession(), expiresIn: ADMIN_SESSION_MS / 1000 }, cors);
        return;
      }

      if (req.method === 'POST' && path === '/admin/content') {
        if (!authorized(req) || !adminAuthorized(req)) { send(res, 401, { error: 'admin_unauthorized' }, cors); return; }
        send(res, 200, await handleContentWrite(await readJson(req, 5_700_000)), cors);
        return;
      }

      if (req.method === 'POST' && path === '/admin/upload') {
        if (!authorized(req) || !adminAuthorized(req)) { send(res, 401, { error: 'admin_unauthorized' }, cors); return; }
        send(res, 200, await uploadNoticeFile(await readJson(req, 14_200_000)), cors);
        return;
      }

      if (req.method === 'POST' && (path === '/calendar' || path === '/detail')) {
        if (!authorized(req)) {
          send(res, 401, { error: 'unauthorized' }, cors);
          return;
        }
        const body = await readJson(req);
        const result = path === '/calendar' ? await handleCalendar(body) : await handleDetail(body);
        send(res, 200, result, cors);
        return;
      }

      send(res, 404, { error: 'not_found' }, cors);
    } catch (e) {
      if (e instanceof AdapterError) {
        // 계정 정보·URL·쿠키는 로그에 남기지 않는다 (CLAUDE.md §10)
        console.error(`[${e.code}] ${e.message}`);
        send(res, HTTP_STATUS[e.code], { error: e.code, message: e.message }, cors);
        return;
      }
      console.error('[unexpected]', (e as Error).message);
      send(res, 500, { error: 'internal' }, cors);
    }
  })();
});

server.listen(PORT, () => {
  console.log(`anc-resort-bot listening on ${PORT}`);
  console.log(`  허용 출처: ${ALLOWED_ORIGINS.join(', ') || '(없음 — CORS 전부 거부)'}`);
  console.log(`  토큰: ${BOARD_TOKEN ? '설정됨' : '없음 — 조회 요청이 모두 401 이 됩니다'}`);
  console.log(`  관리자 인증: ${ADMIN_PASSWORD ? '설정됨' : '없음'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — 정리 후 종료합니다.`);
    server.close();
    void closeAll().then(() => process.exit(0));
  });
}
