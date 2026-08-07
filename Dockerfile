FROM ghcr.io/cloud-cli/node:latest AS builder

COPY --chown=1000 . .
USER 0
RUN pnpm i && pnpm run build

FROM ghcr.io/cloud-cli/node:latest
COPY --from=builder /home/app/dist/on.js ./on.mjs

ENTRYPOINT [ "node" ]
CMD [ "on.mjs" ]
