FROM ghcr.io/cloud-cli/node:latest

COPY . .
RUN pnpm i && pnpm run build && rm -rf node_modules packages/on/node_modules && pnpm i --prod

CMD [ "./packages/on/dist/on.js", "--daemon" ]
