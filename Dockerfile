# Pixberry ERP (with Signal). Keep /data on a persistent volume: it holds the database and backups.
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    PIXBERRY_DB=/data/pixberry.db \
    PIXBERRY_BACKUP_DIR=/data/backups \
    TRUST_PROXY=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
