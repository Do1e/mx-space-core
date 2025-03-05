FROM node:22-alpine as builder
WORKDIR /app
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org/alpine#https://mirror.nju.edu.cn/alpine#g' /etc/apk/repositories
RUN apk add git make g++ alpine-sdk python3 py3-pip unzip
COPY . .
RUN corepack enable
RUN corepack prepare --activate
RUN pnpm install
RUN pnpm bundle
RUN mv apps/core/out ./out
RUN node apps/core/download-latest-admin-assets.js
RUN node apps/core/update-class.js

FROM node:22-alpine

RUN sed -i 's#https\?://dl-cdn.alpinelinux.org/alpine#https://mirror.nju.edu.cn/alpine#g' /etc/apk/repositories
RUN apk add zip unzip mongodb-tools bash fish rsync jq curl openrc proxychains-ng --no-cache

RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
    CF_ARCH="arm64"; \
    elif [ "$ARCH" = "x86_64" ]; then \
    CF_ARCH="amd64"; \
    else \
    echo "Unsupported architecture: $ARCH"; exit 1; \
    fi && \
    curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
    -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

RUN echo -e '[ProxyList]\nhttp 172.17.0.1 22444\nsocks5 172.17.0.1 22445' > /etc/proxychains/proxychains.conf

WORKDIR /app
COPY --from=builder /app/out .
COPY --from=builder /app/assets ./assets

RUN npm i sharp -g
RUN npm i sharp

COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

ENV TZ=Asia/Shanghai

EXPOSE 2333

ENTRYPOINT [ "./docker-entrypoint.sh" ]
