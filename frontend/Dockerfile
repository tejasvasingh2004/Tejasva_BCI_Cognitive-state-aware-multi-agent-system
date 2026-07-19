FROM node:20-alpine

WORKDIR /workspace

# Copy dependency configs
COPY package*.json ./

# Install packages
RUN npm install

# Copy source code
COPY . .

# Build Next.js application
RUN npm run build

# Expose Next.js port
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Start Next.js in production mode
CMD ["npm", "run", "start"]
