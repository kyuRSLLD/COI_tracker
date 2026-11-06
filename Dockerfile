# Multi-stage production build — Railway compatible
FROM node:26-alpine AS builder

WORKDIR /app

# Install dependencies (root + workspaces)
COPY package.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install

# Copy source and build
COPY tsconfig.json* ./
COPY server/ server/
COPY client/ client/
RUN npm run build

# Production runtime stage
FROM node:26-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5001

COPY package.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --omit=dev --workspace=server --workspace=client --ignore-scripts

COPY --from=builder /app/server/dist server/dist
COPY --from=builder /app/client/dist client/dist

RUN mkdir -p uploads server/uploads

EXPOSE 5001

CMD ["node", "server/dist/index.js"]
