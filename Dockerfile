FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Hugging Face usually expects port 7860
EXPOSE 7860 
CMD ["node", "index.js"]