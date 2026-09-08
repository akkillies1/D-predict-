FROM node:20-bookworm-slim
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build
CMD ["npm", "start"]
