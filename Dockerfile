FROM ghcr.io/cloud-cli/node:latest

COPY --chown=1000 . .
USER 0
RUN pnpm i && pnpm run build && rm -rf node_modules packages/on/node_modules && pnpm i --prod
USER 1000

CMD [ "./packages/on/dist/on.js", "--daemon" ]
