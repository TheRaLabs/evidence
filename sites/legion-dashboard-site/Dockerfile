FROM node:20-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY sites/legion-dashboard-site ./sites/legion-dashboard-site

RUN pnpm install --frozen-lockfile

WORKDIR /app/sites/legion-dashboard-site

ENV HOST=0.0.0.0
ENV PORT=3002
EXPOSE 3002

CMD ["pnpm", "run", "runtime:start"]
