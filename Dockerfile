# 依赖安装层（供构建与验收复用）
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 构建层：产出纯静态文件到 dist（无业务后端）
FROM deps AS build
WORKDIR /app
COPY tsconfig.json vite.config.ts playwright.config.ts index.html ./
COPY src ./src
COPY e2e ./e2e
RUN npm run build

# 页面运行层：仅用 nginx 托管静态产物
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

# 一次性验收层：内含匹配版本的 Chromium 与系统库
FROM mcr.microsoft.com/playwright:v1.48.2-jammy AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 类型检查 + 单元测试 + Playwright 端到端（webServer 会自动 build 并起 preview）
CMD ["npm", "run", "verify"]
