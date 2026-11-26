FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
