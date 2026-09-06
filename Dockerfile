FROM ghcr.io/cloud-cli/node:latest AS builder

COPY --chown=1000 . .
USER 0
RUN pnpm i && pnpm run build

ENTRYPOINT [ "node" ]
CMD [ "dist/on.js", "start-server" ]
