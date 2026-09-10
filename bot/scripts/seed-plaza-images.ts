/** 플라자: 확인된 예약 코드·객실명과 공식 안내의 객실 유형 사진을 연결한다. */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { getDb } from '../src/store.ts';
const apply=process.argv.includes('--apply');
const page='https://www.hanwharesort.co.kr/irsweb/resort3/resort/plaza/rsa_room.do?bp_cd=3901';
const base='https://www.hanwharesort.co.kr/irsweb/resort3/app/images/alliance/room_img/';
const mappings=[
 {code:'BUK',name:'비즈니스 룸',file:'pic_theplaza_08.jpg'},
 {code:'DXK',name:'디럭스 룸 (킹)',file:'pic_theplaza_01.jpg'},
 {code:'DXT',name:'디럭스 룸 (트윈)',file:'pic_theplaza_01.jpg'},
 {code:'PMK',name:'프리미어 스위트',file:'pic_theplaza_02.jpg'},
 {code:'CPK',name:'플라자 스위트',file:'pic_theplaza_03.jpg'},
];
const rooms=JSON.parse(await readFile(new URL('../docs/hanwha-images/plaza-rooms.json',import.meta.url),'utf8'));
const pageResponse=await fetch(page,{signal:AbortSignal.timeout(20000)});
if(!pageResponse.ok)throw Error('플라자 공식 페이지 오류');
const html=await pageResponse.text();
const db=getDb();const bucket=getStorage().bucket('anc-resort-rooms');
const copied=new Map<string,string>();
for(const mapping of mappings){
 if(!rooms.some((r:{code:string;name:string})=>r.code===mapping.code&&r.name===mapping.name)) throw Error('플라자 객실 코드/이름 미확인');
 if(!html.includes('room_img/'+mapping.file))throw Error('공식 사진 변경 감지');
 const source=base+mapping.file;
 const res=await fetch(source,{signal:AbortSignal.timeout(20000)});
 const type=res.headers.get('content-type')??'';
 if(!res.ok||!type.startsWith('image/'))throw Error('플라자 이미지 응답 오류');
 const bytes=Buffer.from(await res.arrayBuffer());
 if(!bytes.length)throw Error('빈 이미지');
 if(apply){
  let url=copied.get(source);
  if(!url){
   const hash=createHash('sha256').update(bytes).digest('hex').slice(0,20);
   const path=`rooms/hanwha-plaza/${hash}`;const token=randomUUID();
   await bucket.file(path).save(bytes,{resumable:false,contentType:type,metadata:{cacheControl:'public, max-age=31536000',metadata:{firebaseStorageDownloadTokens:token}}});
   url=`https://firebasestorage.googleapis.com/v0/b/anc-resort-rooms/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
   copied.set(source,url);
  }
  await db.collection('rooms').doc(`hanwha-3901-${mapping.code}`).set({nodeId:'hanwha-loc-3901',images:[url],imageSourceUrls:[source],imageSourcePage:page,photoNote:mapping.code.startsWith('DX')?'객실 유형 대표 사진 · 침대 구성은 예약 유형에 따라 다릅니다.':null,updatedAt:new Date()},{merge:true});
 }
 console.log(`플라자 ${mapping.code}: 사진 ${apply?'저장':'확인'}`);
 await new Promise(r=>setTimeout(r,1200));
}
await writeFile(new URL('../docs/hanwha-images/plaza-mapping.json',import.meta.url),JSON.stringify({checkedAt:'2026-09-10',sourcePage:page,applied:apply,mappings:mappings.map(m=>({...m,source:base+m.file}))},null,2)+'\n');
