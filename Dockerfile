FROM node:20-alpine

# Build tools needed for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/ ./public/

# Data volume for uploads, chunks, and SQLite DB
VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

CMD ["node", "server.js"]
