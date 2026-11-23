FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --chown=node:node index.html admin.html favicon.svg icon-512.webp ninja-logo.webp social-icons.mjs server.mjs package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
