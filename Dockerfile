ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION}

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .

USER node
EXPOSE 3000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
