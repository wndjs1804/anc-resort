# Playwright 공식 이미지. 태그의 버전은 package.json 의 playwright 버전과 반드시 같아야 한다.
# 브라우저가 /ms-playwright 에 미리 들어 있으므로 npm 설치 때 다시 받지 않는다.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# Cloud Run 은 이 포트로 요청을 보낸다.
EXPOSE 8080

# 컨테이너는 root 로 돌리지 않는다 (이미지가 제공하는 사용자).
USER pwuser

CMD ["npx", "tsx", "src/server.ts"]
