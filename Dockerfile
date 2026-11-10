FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3
COPY --chown=node:node . .
RUN mkdir -p data/videos data/images data/output data/uploads data/audit && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
