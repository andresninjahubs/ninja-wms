#!/bin/sh
# Arranque del WMS en contenedor.
# En modo PERSISTENCE=prisma aplica el esquema a la base de datos ANTES de arrancar
# (idempotente: si el esquema ya existe, no hace nada). En modo memory arranca directo.
set -e

if [ "$PERSISTENCE" = "prisma" ]; then
  echo "→ Aplicando el esquema a la base de datos (prisma db push)…"
  # Si la base viene de una versión antigua y el cambio de esquema borra columnas/tablas,
  # prisma se niega en modo no interactivo. PRISMA_ACCEPT_DATA_LOSS=true lo autoriza
  # (úsalo solo en bases de prueba o después de respaldar).
  if [ "$PRISMA_ACCEPT_DATA_LOSS" = "true" ]; then
    npx prisma db push --skip-generate --accept-data-loss
  else
    npx prisma db push --skip-generate
  fi
fi

echo "→ Iniciando Ninja WMS…"
exec node dist/src/main.js
