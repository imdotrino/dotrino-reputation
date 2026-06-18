# Imagen del servidor de reputación (Node + pg). Sin dependencias nativas.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=8091
EXPOSE 8091

CMD ["node", "server.js"]
