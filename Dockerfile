# Optional containerized deploy. See docker-compose.yml for volumes/secrets.
FROM node:20-slim

WORKDIR /app

# Install prod deps first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# auth/, data/, credentials/ are mounted as volumes at runtime (see compose),
# so the WhatsApp session and state persist across container restarts.
CMD ["node", "index.js"]
