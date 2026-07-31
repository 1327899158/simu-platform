# ---- 构建阶段 ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- 运行阶段 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=80 \
    TZ=Asia/Shanghai \
    ALLOW_ENGINEER_SELF_VERIFY=true

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

EXPOSE 80

# 健康检查（云托管探针用）
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:80/api/health || exit 1

CMD ["node", "src/main.js"]
