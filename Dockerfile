FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY openapi.yaml llms.txt tsconfig.json ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8789 MOMO_SQLITE=/data/momo.db
EXPOSE 8789
CMD ["node_modules/.bin/tsx", "src/index.ts"]
