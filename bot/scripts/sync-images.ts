/**
 * 객실 사진을 소노에서 받아 우리 Storage 로 옮긴다 (CLAUDE.md §10)
 *
 *   npm run sync:images              아직 사진이 없는 객실만
 *   npm run sync:images -- --force   전부 다시
 *   npm run sync:images -- --limit=5 몇 개만 시험
 *
 * 로그인이 필요 없다. 사진 주소는 비로그인으로 열린다.
 * 올린 사진은 추측할 수 없는 다운로드 토큰이 붙은 주소로만 볼 수 있다.
 */

import crypto from 'node:crypto';

import { getStorage } from 'firebase-admin/storage';

import { getDb } from '../src/store.ts';

const BUCKET = 'anc-resort-rooms';
const CONCURRENCY = 5;
const PAUSE_MS = 150;             // 소노 서버에 몰아치지 않게

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? 0) || 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RoomRow = { id: string; imageSourceUrls?: string[]; images?: string[] };

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function main(): Promise<void> {
  console.log('');
  console.log('  객실 사진 동기화');
  console.log('  ──────────────────────────────────────────────');

  const db = getDb();
  const snap = await db.collection('rooms').get();
  const all: RoomRow[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RoomRow, 'id'>) }));

  let targets = all.filter((r) => (r.imageSourceUrls?.length ?? 0) > 0);
  if (!FORCE) targets = targets.filter((r) => (r.images?.length ?? 0) === 0);
  if (LIMIT) targets = targets.slice(0, LIMIT);

  const totalImages = targets.reduce((a, r) => a + (r.imageSourceUrls?.length ?? 0), 0);
  console.log(`  전체 객실 ${all.length} · 대상 ${targets.length} · 사진 ${totalImages}장`);
  if (targets.length === 0) {
    console.log('  올릴 사진이 없습니다.\n');
    return;
  }

  const bucket = getStorage().bucket(BUCKET);
  let done = 0;
  let failed = 0;

  await pool(targets, CONCURRENCY, async (room) => {
    const urls: string[] = [];
    for (const [i, src] of (room.imageSourceUrls ?? []).entries()) {
      try {
        const res = await fetch(src, {
          headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') ?? 'image/jpeg';
        if (!contentType.startsWith('image/')) throw new Error(`이미지가 아님 (${contentType})`);
        const buf = Buffer.from(await res.arrayBuffer());

        const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
        const objectPath = `rooms/${room.id}/${i}.${ext}`;
        const token = crypto.randomUUID();

        await bucket.file(objectPath).save(buf, {
          resumable: false,
          contentType,
          metadata: {
            cacheControl: 'public, max-age=31536000',
            metadata: { firebaseStorageDownloadTokens: token },
          },
        });

        urls.push(
          `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`,
        );
        await sleep(PAUSE_MS);
      } catch (e) {
        failed++;
        console.log(`  ✗ ${room.id} #${i} — ${(e as Error).message}`);
      }
    }

    if (urls.length) {
      await db.collection('rooms').doc(room.id).set({ images: urls, updatedAt: new Date() }, { merge: true });
    }
    done++;
    if (done % 20 === 0 || done === targets.length) {
      console.log(`  ${done}/${targets.length} 객실 처리`);
    }
  });

  console.log('  ──────────────────────────────────────────────');
  console.log(`  완료 · 실패한 사진 ${failed}장`);
  console.log('');
}

main().catch((e) => {
  console.error('\n  실패:', (e as Error).message);
  process.exit(1);
});
