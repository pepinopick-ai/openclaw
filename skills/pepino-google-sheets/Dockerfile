FROM node:22-slim
WORKDIR /app
RUN npm init -y && npm install googleapis
COPY sheets-api.js sheets.js api-auth.js api-auth.cjs ./
CMD ["node", "sheets-api.js"]
