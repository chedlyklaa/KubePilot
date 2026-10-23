# One image for every KubePilot process — the orchestrator (index.js) and each agent
# service (agent-services/<name>.js). Which one a container runs is chosen by its
# command (see deploy/docker-compose.yml), so all services always ship the same code
# version and the mesh envelope/protocol can't drift between them.
#
# Build from the repo root:  docker build -f deploy/Dockerfile -t kubepilot:dev .
FROM node:22-slim

# kubectl is only exercised by the processes that hold cluster credentials
# (orchestrator detection, k8s-read, k8s-write) but is cheap to keep in the shared image.
ARG KUBECTL_VERSION=v1.31.4
ARG TARGETARCH=amd64
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY agent-services ./agent-services
COPY config ./config

ENV NODE_ENV=production
USER node
CMD ["node", "index.js"]
