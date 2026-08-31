# The server speaks MCP over stdio, so this image runs attached and dies with
# its client: `docker run -i --rm ...`. There is no port to expose and no
# daemon to supervise.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production dependencies are resolved in their own stage so the TypeScript
# compiler and the test tooling never reach the shipped layer.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app

# The budget cache lives in ACTUAL_DATA_DIR. Without a volume every start
# re-downloads the whole budget from the server, which is slow and hammers it.
ENV NODE_ENV=production \
    ACTUAL_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
VOLUME ["/data"]

# No --unhandled-rejections flag: src/utils/process-guards.ts installs the
# handler in code, so a rejected sync promise no longer kills the process.
ENTRYPOINT ["node", "dist/index.js"]
