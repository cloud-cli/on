FROM ghcr.io/cloud-cli/image-node:latest AS builder

COPY --chown=1000 . .
RUN pnpm i && pnpm run build

FROM ghcr.io/cloud-cli/image-node:latest

COPY --from=builder /home/app/dist ./dist
COPY --from=builder /home/app/package.json /home/app/pnpm-*.yaml ./
RUN pnpm install --prod --frozen-lockfile
ENTRYPOINT [ "node" ]
CMD [ "dist/on.js", "start-server" ]
