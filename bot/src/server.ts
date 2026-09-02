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

import { ananttiAdapter } from './adapters/anantti.ts';
import { hanwhaAdapter } from './adapters/hanwha.ts';
import { sonoAdapter } from './adapters/sono.ts';
import { AdapterError, type AdapterErrorCode, type Node, type ResortAdapter, type ResortId } from './adapters/types.ts';
import { closeAll, getContext, getLoginCount } from './browser.ts';
import { getChildNodes, getNode, writeDetail, writeSnapshot } from './store.ts';

const PORT = Number(process.env.PORT ?? 8080);

/** 게시판 토큰. Secret Manager 가 BOARD_TOKEN 으로 넣어 준다. */
const BOARD_TOKEN = process.env.BOARD_TOKEN ?? '';

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

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return allow
    ? {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new AdapterError('parse_failed', '요청이 너무 큽니다.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AdapterError('parse_failed', '요청 본문이 JSON 이 아닙니다.');
  }
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
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — 정리 후 종료합니다.`);
    server.close();
    void closeAll().then(() => process.exit(0));
  });
}
