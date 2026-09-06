FROM ghcr.io/cloud-cli/node:latest AS builder

COPY --chown=1000 . .
USER 0
RUN pnpm i && pnpm run build

FROM ghcr.io/cloud-cli/node:latest

WORKDIR /home/app
COPY --from=builder /home/app/dist ./dist
COPY --from=builder /home/app/package.json /home/app/pnpm-lock.yaml ./
USER 0
RUN pnpm install --prod --frozen-lockfile

ENTRYPOINT [ "node" ]
CMD [ "dist/on.js", "start-server" ]
