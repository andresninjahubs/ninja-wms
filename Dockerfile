# Imagen del WMS (API + panel /admin + PWA /app). Sirve para Railway, Render, Fly.io o cualquier host Docker.
# Base Debian slim + openssl para que el cliente de Prisma (PostgreSQL) funcione de forma confiable.
#
# Producción: define en el host las variables PERSISTENCE=prisma, DATABASE_URL, AUTH_REQUIRED=true,
# AUTH_SECRET, ROOT_PASSWORD y SEED_DEMO=false (ver .env.prod.example y DEPLOY-RAILWAY.md).

# --- Build ---
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
# Tolerante a redes que restringen la verificación de checksum del engine (igual lo descarga).
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
RUN npx prisma generate
RUN npm run build

# --- Runtime ---
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Valores por defecto seguros; el host los sobreescribe con variables de entorno.
ENV PERSISTENCE=memory
ENV SEED_DEMO=false
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/pwa ./pwa
COPY --from=build /app/webadmin ./webadmin
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
# El host suele inyectar PORT; el server usa process.env.PORT ?? 3000.
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
