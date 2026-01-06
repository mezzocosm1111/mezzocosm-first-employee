FROM node:20-slim

WORKDIR /app

# Copy package definition
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code and docs
# We copy everything in the current directory (mezzo/) into /app
# This includes src/, sops/, README.md, etc.
COPY . .

# Expose port
EXPOSE 10000

# Start server
CMD ["npm", "start"]
