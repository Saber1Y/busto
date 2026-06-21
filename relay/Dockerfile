FROM node:22-bookworm-slim

# Build tools are a fallback in case prebuilt binaries for the native deps
# (udx-native, sodium-native) are unavailable for the target platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV RELAY_PORT=49737
EXPOSE 49737/udp

CMD ["node", "index.js"]
