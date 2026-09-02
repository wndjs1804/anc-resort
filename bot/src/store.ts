/**
 * Firestore 읽기/쓰기 (Admin SDK).
 *
 * 인증은 ADC(Application Default Credentials)를 쓴다. 로컬에서는 한 번만:
 *   gcloud auth application-default login --project=anc-resort
 * 키 파일을 만들지 않는다. (CLAUDE.md §10)
 */

import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'anc-resort';

/** Firestore 배치 쓰기 상한은 500. 여유를 둔다. */
const BATCH_SIZE = 400;

let db: Firestore | null = null;

export function getDb(): Firestore {
  if (db) return db;
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  }
  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

export type NodeDoc = {
  id: string;
  resortId: string;
  parentId: string | null;
  level: string;
  name: string;
  order: number;
  bookable: boolean;
  siteRef: Record<string, unknown>;
  active: boolean;
};

export type RoomDoc = {
  id: string;
  nodeId: string;
  path: string[];
  capacityStd: number | null;
  capacityMax: number | null;
  capacityText: string | null;
  /** 정원이 조건부(예: 반려견 크기별)라 숫자 하나로 못 줄이는 경우. 화면은 capacityText 를 보여준다. */
  capacityAmbiguous: boolean;
  areaText: string | null;
  /** Storage 사본 (gs://…). 결제 계정 연결 후 채운다. */
  images: string[];
  /** 소노 원본 이미지 주소. Storage 복사 전까지의 출처 기록. */
  imageSourceUrls: string[];
  siteRef: Record<string, unknown>;
  active: boolean;
};

/** 컬렉션에 문서들을 통째로 덮어쓴다(merge). 같은 id 로 다시 실행해도 안전하다. */
async function writeAll(collection: string, docs: Array<{ id: string } & Record<string, unknown>>): Promise<number> {
  const database = getDb();
  let written = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = database.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      const { id, ...rest } = doc;
      batch.set(database.collection(collection).doc(id), { ...rest, updatedAt: new Date() }, { merge: true });
    }
    await batch.commit();
    written += Math.min(BATCH_SIZE, docs.length - i);
  }
  return written;
}

export async function writeResort(resortId: string, name: string): Promise<void> {
  await getDb().collection('resorts').doc(resortId).set({ name, active: true, updatedAt: new Date() }, { merge: true });
}

export async function writeNodes(nodes: NodeDoc[]): Promise<number> {
  return writeAll('nodes', nodes as unknown as Array<{ id: string } & Record<string, unknown>>);
}

export async function writeRooms(rooms: RoomDoc[]): Promise<number> {
  return writeAll('rooms', rooms as unknown as Array<{ id: string } & Record<string, unknown>>);
}

/** 어떤 노드의 자식들. 동별 잔여를 만들 때 형제 동을 찾는 데 쓴다. */
export async function getChildNodes(parentId: string): Promise<NodeDoc[]> {
  const snap = await getDb().collection('nodes').where('parentId', '==', parentId).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as NodeDoc)
    .filter((n) => n.active)
    .sort((a, b) => a.order - b.order);
}

/** 달력 마지막 조회 결과 (CLAUDE.md §6 snapshots) */
export async function writeSnapshot(
  nodeId: string, yyyyMM: string, days: Record<string, string>, fetchedAt: Date,
): Promise<void> {
  await getDb().collection('snapshots').doc(`${nodeId}_${yyyyMM}`).set(
    { nodeId, yyyyMM, nights: 1, days, fetchedAt }, { merge: true },
  );
}

/** 날짜 상세 마지막 조회 결과 (CLAUDE.md §6 details) */
export async function writeDetail(
  nodeId: string, checkin: string, nights: number, payload: Record<string, unknown>, fetchedAt: Date,
): Promise<void> {
  await getDb().collection('details').doc(`${nodeId}_${checkin}_${nights}`).set(
    { nodeId, checkin, nights, ...payload, fetchedAt }, { merge: true },
  );
}

export async function getNode(nodeId: string): Promise<NodeDoc | null> {
  const snap = await getDb().collection('nodes').doc(nodeId).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as NodeDoc) : null;
}
