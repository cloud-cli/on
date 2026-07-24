FROM ghcr.io/cloud-cli/node:latest AS builder

COPY --chown=1000 . .
USER 0
RUN pnpm i && pnpm run build

FROM ghcr.io/cloud-cli/node:latest
COPY --from=builder /home/app/packages/on/dist/on.js ./on.mjs
ENV WORKFLOW_HOST "0.0.0.0"
ENTRYPOINT [ "node" ]
CMD [ "on.mjs" ]
