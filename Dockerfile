FROM node:20-alpine AS base
WORKDIR /app

RUN apk add --no-cache docker-cli

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY views ./views
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
