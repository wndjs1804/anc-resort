/** 공식 숙소+객실 코드로 사진 수집. 기본 dry-run, --apply로 Storage/Firestore 저장. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { getDb } from '../src/store.ts';
import { parseHanwhaGallery } from './lib/hanwha-images.ts';
const apply=process.argv.includes('--apply');
const limit=Number(process.argv.find(x=>x.startsWith('--limit='))?.slice(8)??0);
const manifest=JSON.parse(await readFile(new URL('../docs/hanwha-images/manifest.json',import.meta.url),'utf8'));
const targets=manifest.places.flatMap((p:{locCd:string;sourcePage:string;rooms:Array<{code:string;name:string}>})=>p.rooms.map(r=>({...r,locCd:p.locCd,page:p.sourcePage+'&rm_cd='+encodeURIComponent(r.code)})));
const db=getDb();
const bucket=getStorage().bucket('anc-resort-rooms');
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const results:Array<Record<string,unknown>>=[];
const copied=new Map<string,string>();
let failed=0;
for(const room of (limit?targets.slice(0,limit):targets)) {
 const id=`hanwha-${room.locCd}-${room.code}`;
 try {
  const response=await fetch(room.page,{signal:AbortSignal.timeout(25000)});
  if(!response.ok) throw Error(`안내 페이지 HTTP ${response.status}`);
  const html=await response.text();
  if(/비정상적인 접근|접근이 차단|자동입력 방지/.test(html)) throw Error('접근 제한: 중단');
  const gallerySources=parseHanwhaGallery(html,room.page,room.code);
  let sources=gallerySources.slice(0,1);
  if(apply) {
   const old=(await db.collection('rooms').doc(id).get()).data();
   if (old?.images?.length === gallerySources.length && JSON.stringify(old.imageSourceUrls) === JSON.stringify(gallerySources)) sources=gallerySources;
   const images:string[]=[];
   for(const [i,source] of sources.entries()) {
    const oldIndex=old?.imageSourceUrls?.indexOf(source)??-1;
    if(oldIndex>=0&&old?.images?.[oldIndex]) { images.push(old.images[oldIndex]);continue; }
    if(copied.has(source)) { images.push(copied.get(source)!);continue; }
    const res=await fetch(source,{signal:AbortSignal.timeout(25000)});
    const contentType=res.headers.get('content-type')??'';
    if(!res.ok||!contentType.startsWith('image/')) throw Error(`사진 ${i+1} HTTP ${res.status}`);
    const bytes=Buffer.from(await res.arrayBuffer());
    if(!bytes.length) throw Error('빈 이미지');
    const hash=createHash('sha256').update(bytes).digest('hex').slice(0,20);
    const path=`rooms/${id}/${hash}`;
    const token=randomUUID();
    await bucket.file(path).save(bytes,{resumable:false,contentType,metadata:{cacheControl:'public, max-age=31536000',metadata:{firebaseStorageDownloadTokens:token}}});
    const url=`https://firebasestorage.googleapis.com/v0/b/anc-resort-rooms/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    images.push(url);copied.set(source,url);
    await pause(200);
   }
   await db.collection('rooms').doc(id).set({nodeId:`hanwha-loc-${room.locCd}`,images,imageSourceUrls:sources,gallerySourceUrls:gallerySources,imageSourcePage:room.page,updatedAt:new Date()},{merge:true});
  }
  results.push({id,sourcePage:room.page,name:room.name,sources,status:apply?'saved':'checked'});
  console.log(`${results.length}/${limit||targets.length} ${id}: ${sources.length}장 ${apply?'저장':'확인'}`);
 } catch(error) {
  failed++;
  const message=(error as Error).message;
  results.push({id,status:'failed',error:message});
  console.log(`${id}: ${message}`);
  if(message.includes('접근 제한')) break;
 }
 await pause(1200);
}
await writeFile(new URL('../docs/hanwha-images/collection-result.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),apply,results},null,2)+'\n');
console.log(`완료: ${results.length-failed}객실, 실패 ${failed}객실`);
if(failed) process.exitCode=1;
