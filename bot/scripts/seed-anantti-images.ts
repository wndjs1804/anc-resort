/** 확인한 아난티 사진을 Storage에 복사하고 객실별·그룹별로 연결한다. 기본은 dry-run. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { getDb, getNode } from '../src/store.ts';
import { getContext, closeAll } from '../src/browser.ts';
import { ananttiAdapter, PROPERTIES } from '../src/adapters/anantti.ts';
import { ananttiImageRules } from '../src/adapters/anantti-images.ts';
import type { Node } from '../src/adapters/types.ts';

const apply = process.argv.includes('--apply');
const pause = () => new Promise(r => setTimeout(r, 1200));
async function main() {
  const db = getDb();
  process.env.SESSION_KEY = execFileSync('gcloud', ['secrets','versions','access','latest','--secret=session-key','--project=anc-resort'], { encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
  const ctx = await getContext('anantti');
  await ananttiAdapter.ensureSession(ctx);
  const date = new Date(); date.setDate(date.getDate() + 30);
  const checkin = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const matched: Array<{id:string;nodeId:string;group:string}> = [];
  for (const p of Object.values(PROPERTIES)) {
    const nodeId = `anantti-place-${p.path}`;
    const node = await getNode(nodeId);
    if (!node) throw Error(`노드 없음: ${nodeId}`);
    const detail = await ananttiAdapter.getDetail(ctx, node as Node, checkin, 1);
    for (const room of detail.rooms) {
      const group = room.siteRef?.photoGroup;
      if (typeof group === 'string') matched.push({id:room.roomId,nodeId,group});
      else console.log(`사진 미연결: ${room.roomId}`);
    }
    console.log(`${p.path}: ${detail.rooms.length}객실 중 ${matched.filter(r=>r.nodeId===nodeId).length}객실 연결`);
    await pause();
  }
  const seen = new Map<string,string>();
  for (const room of matched) {
    if (seen.has(room.id) && seen.get(room.id) !== room.group) throw Error(`객실 사진 그룹 충돌: ${room.id}`);
    seen.set(room.id, room.group);
  }
  console.log(`확인된 사진 그룹 ${ananttiImageRules.length}개 · 예약 객실 ${matched.length}개 · ${apply?'저장':'dry-run'}`);
  if (!apply) return;
  const bucket = getStorage().bucket('anc-resort-rooms');
  const groupImages = new Map<string,string[]>();
  for (const rule of ananttiImageRules) {
    const group = `anantti-photo-${rule.property}-${rule.group}`;
    const old = await db.collection('rooms').doc(group).get();
    let images: string[] = old.data()?.images ?? [];
    if (!images.length || old.data()?.imageSourceUrls?.[0] !== rule.image) {
      const res = await fetch(rule.image, { signal: AbortSignal.timeout(20000) });
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !contentType.startsWith('image/')) throw Error(`사진 다운로드 실패: ${rule.property}/${rule.group}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw Error('빈 사진');
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0,16);
      const objectPath = `rooms/${group}/${hash}.jpg`;
      const token = randomUUID();
      await bucket.file(objectPath).save(bytes, { resumable:false, contentType, metadata:{ cacheControl:'public, max-age=31536000', metadata:{firebaseStorageDownloadTokens:token} } });
      images = [`https://firebasestorage.googleapis.com/v0/b/anc-resort-rooms/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`];
      await pause();
    }
    await db.collection('rooms').doc(group).set({nodeId:`anantti-place-${rule.property}`,images,imageSourceUrls:[rule.image],photoGroup:true,updatedAt:new Date()}, {merge:true});
    groupImages.set(group,images);
  }
  const batch = db.batch();
  for (const room of matched) {
    const images = groupImages.get(room.group);
    if (!images?.length) throw Error(`사진 그룹 없음: ${room.group}`);
    batch.set(db.collection('rooms').doc(room.id), {nodeId:room.nodeId,images,photoGroupId:room.group,updatedAt:new Date()}, {merge:true});
  }
  await batch.commit();
  console.log(`저장 완료: ${groupImages.size}개 사진 그룹, ${matched.length}개 예약 객실`);
}
main().catch(()=>{console.error('사진 연결 실패: 인증정보 보호를 위해 원문 오류는 생략합니다.');process.exitCode=1;}).finally(closeAll);
