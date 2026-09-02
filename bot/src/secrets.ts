/**
 * 리조트 계정 자격 읽기.
 *
 * Phase 1(로컬 실행) 기준: 환경변수 → 없으면 터미널에서 직접 입력받는다.
 * 비밀번호는 화면에 찍히지 않고, 파일·로그·Firestore 어디에도 저장하지 않는다.
 *
 * TODO(Phase 3): Cloud Run 배포 시 Google Secret Manager 에서 읽도록 이 파일만 교체한다.
 *                (CLAUDE.md §4, §11 — SONO_ID=sono-id:latest 형태로 주입)
 */

import readline from 'node:readline';

export type Credentials = { id: string; pw: string; extra?: string };

/** 화면에 보이는 질문 */
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 입력이 화면에 찍히지 않는 질문 (비밀번호용) */
function askHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  let muted = false;

  // 입력 중에는 출력을 삼킨다. 질문 문구는 rl.question 이 동기적으로 먼저 쓰므로 그대로 보인다.
  (stdout as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c, ...a) =>
    muted ? true : (write as unknown as (c: unknown, ...a: unknown[]) => boolean)(c, ...a);

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      muted = false;
      (stdout as unknown as { write: unknown }).write = write;
      stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

/**
 * 리조트별 환경변수 이름과 표시 이름.
 * `extra` 는 아이디·비밀번호 말고 하나 더 필요한 경우다 (한화의 회원권 비밀번호).
 */
const RESORTS: Record<string, {
  name: string; idEnv: string; pwEnv: string;
  extra?: { env: string; label: string };
}> = {
  sono: { name: '소노', idEnv: 'SONO_ID', pwEnv: 'SONO_PW' },
  anantti: { name: '아난티', idEnv: 'ANANTTI_ID', pwEnv: 'ANANTTI_PW' },
  hanwha: {
    name: '한화', idEnv: 'HANWHA_ID', pwEnv: 'HANWHA_PW',
    extra: { env: 'HANWHA_MEMBER_PW', label: '회원권 비밀번호' },
  },
};

/**
 * 리조트 계정을 얻는다.
 * 1) 환경변수가 있으면 그것을 쓴다 (Cloud Run 은 Secret Manager 가 넣어 준다)
 * 2) 없으면 터미널에서 물어본다 (로컬 실행용)
 */
export async function getCredentials(resortId: string): Promise<Credentials> {
  const cfg = RESORTS[resortId];
  if (!cfg) throw new Error(`모르는 리조트입니다: ${resortId}`);

  const envId = process.env[cfg.idEnv]?.trim();
  const envPw = process.env[cfg.pwEnv];

  const envExtra = cfg.extra ? process.env[cfg.extra.env] : undefined;

  if (envId && envPw && (!cfg.extra || envExtra)) {
    console.log(`  계정: 환경변수(${cfg.idEnv}/${cfg.pwEnv}${cfg.extra ? '/' + cfg.extra.env : ''})에서 읽음`);
    return { id: envId, pw: envPw, ...(envExtra ? { extra: envExtra } : {}) };
  }

  if (!process.stdin.isTTY) {
    const envs = [cfg.idEnv, cfg.pwEnv, ...(cfg.extra ? [cfg.extra.env] : [])].join(' / ');
    throw new Error(
      `${cfg.name} 계정을 입력받을 수 없습니다. 터미널에서 직접 실행하거나 ${envs} 환경변수를 설정하세요.`,
    );
  }

  console.log('');
  console.log(`  ${cfg.name} 회원 계정을 입력하세요. 입력한 값은 이 실행 중에만 메모리에 있고,`);
  console.log('  파일이나 로그에 저장되지 않습니다. 비밀번호는 화면에 보이지 않습니다.');
  console.log('');

  const id = envId ?? (await ask('  아이디: '));
  const pw = envPw ?? (await askHidden('  비밀번호: '));
  const extra = cfg.extra ? (envExtra ?? (await askHidden(`  ${cfg.extra.label}: `))) : undefined;

  if (!id || !pw) throw new Error('아이디와 비밀번호가 모두 필요합니다.');
  if (cfg.extra && !extra) throw new Error(`${cfg.extra.label}가 필요합니다.`);
  return { id, pw, ...(extra ? { extra } : {}) };
}

/** 소노 전용 단축 (기존 호출부 호환) */
export const getSonoCredentials = () => getCredentials('sono');
