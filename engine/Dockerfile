FROM node:20-bookworm-slim
WORKDIR /app/engine
COPY engine/package*.json ./
RUN npm ci
COPY engine ./
RUN npm run build
CMD ["npm", "run", "forecast"]
