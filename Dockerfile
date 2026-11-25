FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY api/ ./api/
COPY lib/ ./lib/
COPY server.cjs ./server.cjs
USER node
EXPOSE 3000
CMD ["node", "--expose-gc", "--max-old-space-size=320", "server.cjs"]
