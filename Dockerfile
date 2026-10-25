FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY sql ./sql
# The offline demo is deliberately NOT part of the production image:
# demo mode refuses NODE_ENV=production. Use Dockerfile.demo instead.
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
