FROM node:26-alpine
ARG CELIA_BUILD_SHA=unknown
ENV NODE_ENV=production CELIA_BUILD_SHA=$CELIA_BUILD_SHA
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
COPY sql ./sql
COPY releases ./releases
COPY CHANGELOG.md ./CHANGELOG.md
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
