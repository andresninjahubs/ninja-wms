#!/bin/sh
# Arranque del WMS en contenedor.
# En modo PERSISTENCE=prisma aplica el esquema a la base de datos ANTES de arrancar
# (idempotente: si el esquema ya existe, no hace nada). En modo memory arranca directo.
set -e

if [ "$PERSISTENCE" = "prisma" ]; then
  echo "→ Aplicando el esquema a la base de datos (prisma db push)…"
  npx prisma db push --skip-generate
fi

echo "→ Iniciando Ninja WMS…"
exec node dist/src/main.js
