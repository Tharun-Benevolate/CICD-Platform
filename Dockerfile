# ---------------------------------------
# Stage 1: Build and Download Dependencies
# ---------------------------------------
FROM node:20-alpine AS builder

WORKDIR /build

# 1. Install Node modules
COPY package*.json ./
RUN npm ci --omit=dev

# 2. Download and extract Terraform (avoids needing wget/unzip in final image)
RUN apk add --no-cache wget unzip && \
    wget https://releases.hashicorp.com/terraform/1.8.5/terraform_1.8.5_linux_amd64.zip && \
    unzip terraform_1.8.5_linux_amd64.zip -d /build/

# ---------------------------------------
# Stage 2: Minimal Production Runtime
# ---------------------------------------
FROM node:20-alpine

WORKDIR /app

# 1. Install ONLY the runtime system requirements (Git)
RUN apk add --no-cache git

# 2. Copy the Terraform binary from the builder stage
COPY --from=builder /build/terraform /usr/local/bin/terraform

# 3. Copy node_modules from the builder stage
COPY --from=builder /build/node_modules ./node_modules

# 4. Copy the rest of the application source code, owned by the non-root user
COPY --chown=node:node . .

# 5. Install the runtime entrypoint that loads managed secrets before booting Node
RUN chmod +x /app/docker-entrypoint.sh

# 6. Secure the container by running as a non-root user
USER node

EXPOSE 3000

CMD ["/app/docker-entrypoint.sh"]