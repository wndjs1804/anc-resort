/**
 * Playwright 인스턴스와 리조트별 세션 관리 (CLAUDE.md §7.2)
 *
 * - 브라우저는 프로세스당 하나. 리조트마다 BrowserContext 를 하나씩 유지한다.
 * - 세션(쿠키·localStorage)은 Firestore sessions/{resortId} 에 암호화해서 넣는다.
 *   재시작해도 복원해서 쓰므로 매번 로그인하지 않는다.
 * - 로그인은 리조트당 하루 20회로 제한한다. 넘으면 계정 이상 신호로 보고 조회를 실패시킨다.
 */

import crypto from 'node:crypto';
import { chromium, type Browser, type BrowserContext } from 'playwright';

import { getDb } from './store.ts';
import { AdapterError, type ResortId } from './adapters/types.ts';

const VIEWPORT = { width: 1440, height: 900 };

/**
 * User-Agent 를 실제 데스크톱 크롬 값으로 고정한다 (CLAUDE.md §7.4).
 * headless 로 띄우면 기본값이 `HeadlessChrome` 이 되는데, 이건 실제 브라우저 값이 아니다.
 * 스텔스 플러그인 같은 회피 트릭은 쓰지 않는다 — 버전과 OS 는 실제 값 그대로 쓴다.
 */
function desktopUserAgent(browserVersion: string): string {
  const platform =
    process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
  const major = browserVersion.split('.')[0] || '140';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
const LOCALE = 'ko-KR';
const TIMEZONE = 'Asia/Seoul';

/** 리조트당 하루 로그인 상한 */
const MAX_LOGINS_PER_DAY = 20;

/** Firestore 문서 1MB 제한에 걸리지 않도록 여유를 둔다 */
const MAX_SESSION_BYTES = 800_000;

let browser: Browser | null = null;
const contexts = new Map<ResortId, BrowserContext>();

// ─────────────────────────────────────────────────────────────────────────────
// 암호화
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 세션 암호화 키. 운영에서는 Secret Manager 가 SESSION_KEY 로 주입한다 (CLAUDE.md §11).
 * 키가 없으면 세션을 저장하지 않는다 — 쿠키를 평문으로 남기느니 매번 로그인하는 편이 낫다.
 */
function sessionKey(): Buffer | null {
  const raw = process.env.SESSION_KEY;
  if (!raw) return null;
  // 고정 salt. 키 자체가 Secret Manager 에서 오는 고엔트로피 값이라는 전제.
  return crypto.scryptSync(raw, 'anc-resort-session', 32);
}

function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// 세션 저장소 (Firestore sessions/{resortId})
// ─────────────────────────────────────────────────────────────────────────────

type SessionDoc = {
  data?: string;        // 암호화된 storageState
  updatedAt?: Date;
  loginDate?: string;   // yyyy-MM-dd
  loginCount?: number;
};

const today = (): string => new Date().toISOString().slice(0, 10);

async function readSessionDoc(resortId: ResortId): Promise<SessionDoc> {
  const snap = await getDb().collection('sessions').doc(resortId).get();
  return (snap.data() as SessionDoc | undefined) ?? {};
}

/** 저장해 둔 세션을 꺼낸다. 키가 없거나 복호화에 실패하면 null. */
export async function loadStorageState(resortId: ResortId): Promise<unknown | null> {
  const key = sessionKey();
  if (!key) return null;
  try {
    const doc = await readSessionDoc(resortId);
    if (!doc.data) return null;
    return JSON.parse(decrypt(doc.data, key));
  } catch {
    // 키가 바뀌었거나 형식이 깨진 경우. 조용히 버리고 새로 로그인한다.
    return null;
  }
}

export async function saveStorageState(resortId: ResortId, ctx: BrowserContext): Promise<void> {
  const key = sessionKey();
  if (!key) {
    console.warn('  [세션] SESSION_KEY 가 없어 저장하지 않습니다. 다음 실행 때 다시 로그인합니다.');
    return;
  }
  const state = JSON.stringify(await ctx.storageState());
  if (Buffer.byteLength(state) > MAX_SESSION_BYTES) {
    console.warn('  [세션] 저장할 내용이 너무 큽니다. 저장을 건너뜁니다.');
    return;
  }
  await getDb().collection('sessions').doc(resortId).set(
    { data: encrypt(state, key), updatedAt: new Date() },
    { merge: true },
  );
}

/** 로그인을 한 번 더 해도 되는지 확인하고, 된다면 횟수를 올린다. */
export async function claimLoginSlot(resortId: ResortId): Promise<void> {
  const db = getDb();
  const ref = db.collection('sessions').doc(resortId);
  await db.runTransaction(async (tx) => {
    const doc = ((await tx.get(ref)).data() as SessionDoc | undefined) ?? {};
    const day = today();
    const count = doc.loginDate === day ? (doc.loginCount ?? 0) : 0;
    if (count >= MAX_LOGINS_PER_DAY) {
      throw new AdapterError(
        'rate_limited',
        `오늘 로그인 시도가 ${MAX_LOGINS_PER_DAY}회를 넘었습니다. 계정 상태를 확인하세요.`,
      );
    }
    tx.set(ref, { loginDate: day, loginCount: count + 1 }, { merge: true });
  });
}

export async function getLoginCount(resortId: ResortId): Promise<number> {
  const doc = await readSessionDoc(resortId);
  return doc.loginDate === today() ? (doc.loginCount ?? 0) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 브라우저 · 컨텍스트
// ─────────────────────────────────────────────────────────────────────────────

export async function getBrowser(headed = false): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.launch({ headless: !headed, channel: 'chrome' });
  } catch {
    browser = await chromium.launch({ headless: !headed });
  }
  return browser;
}

/** 리조트별 컨텍스트. 저장된 세션이 있으면 복원해서 만든다. */
export async function getContext(resortId: ResortId, headed = false): Promise<BrowserContext> {
  const existing = contexts.get(resortId);
  if (existing) return existing;

  const b = await getBrowser(headed);
  const restored = await loadStorageState(resortId);

  const ctx = await b.newContext({
    viewport: VIEWPORT,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    userAgent: desktopUserAgent(b.version()),
    // 저장해 둔 쿠키·localStorage 가 있으면 그대로 복원한다.
    ...(restored ? { storageState: restored as Parameters<Browser['newContext']>[0] extends { storageState?: infer S } ? S : never } : {}),
  });

  contexts.set(resortId, ctx);
  return ctx;
}

/** 세션이 못 쓰게 됐을 때 컨텍스트를 버리고 새로 만든다. */
export async function resetContext(resortId: ResortId): Promise<void> {
  const ctx = contexts.get(resortId);
  contexts.delete(resortId);
  await ctx?.close().catch(() => {});
}

export async function closeAll(): Promise<void> {
  for (const [id] of contexts) await resetContext(id);
  await browser?.close().catch(() => {});
  browser = null;
}
