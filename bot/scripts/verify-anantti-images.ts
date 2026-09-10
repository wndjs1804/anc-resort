/** 운영 사진 연결과 Storage 파일을 읽기 전용으로 확인한다. URL 토큰은 출력하지 않는다. */
import { getDb } from '../src/store.ts';
import { ananttiImageRules } from '../src/adapters/anantti-images.ts';
const db=getDb();
let linked=0;
for(const p of [...new Set(ananttiImageRules.map(r=>r.property))]) {
  const snap=await db.collection('rooms').where('nodeId','==',`anantti-place-${p}`).get();
  const exact=snap.docs.filter(d=>!d.id.startsWith('anantti-photo-'));
  if(!exact.length || exact.some(d=>!d.data().images?.length)) throw Error(`${p}: 객실 사진 누락`);
  linked+=exact.length;
  console.log(`${p}: ${exact.length}개 객실 사진 연결 확인`);
}
for(const rule of ananttiImageRules) {
  const snap=await db.collection('rooms').doc(`anantti-photo-${rule.property}-${rule.group}`).get();
  const url=snap.data()?.images?.[0];
  if(!url) throw Error('사진 그룹 누락');
  const res=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(20000)});
  if(!res.ok||!res.headers.get('content-type')?.startsWith('image/')) throw Error(`사진 응답 실패: ${rule.property}/${rule.group}`);
}
console.log(`PASS: 예약 객실 ${linked}개 · 사진 그룹 ${ananttiImageRules.length}개 저장소 응답 정상`);
