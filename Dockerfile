FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
# Cloud Run injects PORT (8080); the server reads process.env.PORT.
EXPOSE 8080
CMD ["npx", "tsx", "src/server/index.ts"]
