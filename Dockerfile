# ==========================
# Base image
# ==========================
FROM node:24.11.0-slim AS base
WORKDIR /app

# ==========================
# Build stage
# ==========================
FROM base AS build

# COPY ONLY package.json (no lock file)
COPY package.json ./

# install dependencies (no npm ci, because no lockfile)
RUN npm install --production

# copy the rest of the server files
COPY . .

# ==========================
# Start the server
# ==========================
CMD ["npm", "start"]