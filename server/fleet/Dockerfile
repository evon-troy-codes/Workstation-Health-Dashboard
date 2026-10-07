# Workstation Scanner for Teams: the fleet server as a container, for
# companies that don't use Cloudflare. Same code as the Worker (src/app.js);
# SQLite through Node's built-in node:sqlite. No npm dependencies.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src/ ./src/

ENV NODE_ENV=production \
    PORT=8080 \
    FLEET_DB=/data/fleet.db

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "src/node-server.js"]
