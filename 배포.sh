#!/usr/bin/env bash
# ANC 휴양시설 이용조회 — 배포
#
#   bash 배포.sh          봇 + 화면 둘 다
#   bash 배포.sh bot      봇만
#   bash 배포.sh web      화면만
#
# 비밀은 Secret Manager 에서 읽어 갑니다. 이 파일에는 비밀이 없습니다.

set -euo pipefail
cd "$(dirname "$0")"

PROJECT=anc-resort
REGION=asia-northeast3
SA=anc-resort-bot@anc-resort.iam.gserviceaccount.com
TARGET="${1:-all}"

deploy_bot() {
  echo "▶ 봇 배포 (몇 분 걸립니다)"
  gcloud run deploy anc-resort-bot \
    --source bot/ --project="$PROJECT" --region "$REGION" \
    --service-account "$SA" \
    --min-instances 0 --max-instances 2 --memory 2Gi --cpu 1 --concurrency 4 --timeout 60 \
    --allow-unauthenticated \
    --set-secrets SONO_ID=sono-id:latest,SONO_PW=sono-pw:latest,\
ANANTTI_ID=anantti-id:latest,ANANTTI_PW=anantti-pw:latest,\
HANWHA_ID=hanwha-id:latest,HANWHA_PW=hanwha-pw:latest,HANWHA_MEMBER_PW=hanwha-member-pw:latest,\
SESSION_KEY=session-key:latest,BOARD_TOKEN=board-token:latest \
    --set-env-vars "^@^ALLOWED_ORIGINS=https://anc-resort.web.app,https://anc-resort.firebaseapp.com" \
    | tail -3
}

deploy_web() {
  echo "▶ 화면 배포"
  firebase deploy --only hosting --project "$PROJECT" | tail -3
}

case "$TARGET" in
  bot) deploy_bot ;;
  web) deploy_web ;;
  all) deploy_bot; deploy_web ;;
  *) echo "쓰는 법: bash 배포.sh [bot|web]"; exit 1 ;;
esac

echo
echo "▶ 상태 확인"
curl -s --max-time 120 "https://anc-resort-bot-551643700321.$REGION.run.app/health" || true
echo
