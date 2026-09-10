#!/bin/bash
# =====================================================================
#  Lanzador del WMS Ninja Hubs para Mac  —  solo haz doble clic.
#  Hace todo solo: prepara, construye y enciende el sistema, y abre
#  el panel en tu navegador. Para APAGARLO, cierra esta ventana negra
#  (o presiona Control + C).
# =====================================================================

# Ir a la carpeta donde está este archivo (la del proyecto).
cd "$(dirname "$0")" || exit 1

echo ""
echo "==================================================="
echo "   WMS Ninja Hubs — encendiendo en tu Mac"
echo "==================================================="
echo ""

# 1) Verificar que Node.js esté instalado.
if ! command -v node >/dev/null 2>&1; then
  echo "  ⚠  Falta instalar 'Node.js' (el motor que hace funcionar el sistema)."
  echo ""
  echo "  Cómo instalarlo (una sola vez):"
  echo "   1. Abre este enlace en tu navegador:  https://nodejs.org"
  echo "   2. Descarga el botón que dice 'LTS' (recomendado)."
  echo "   3. Abre el archivo descargado y dale 'Continuar / Instalar'."
  echo "   4. Cuando termine, vuelve a hacer doble clic en este mismo archivo."
  echo ""
  echo "  (Esta ventana se puede cerrar.)"
  echo ""
  read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
  exit 1
fi

echo "  ✓ Node.js detectado ($(node -v))."
echo ""

# 2) Instalar dependencias la primera vez (puede tardar 1-2 minutos).
if [ ! -d "node_modules" ]; then
  echo "  ⏳ Preparando por primera vez (descargando componentes)... esto tarda un poco."
  npm install || { echo "  ✗ Hubo un problema preparando. Revisa tu conexión a internet."; read -n 1 -s -r; exit 1; }
  echo "  ✓ Preparación lista."
  echo ""
fi

# 3) Construir el sistema (traduce el código a su versión ejecutable).
echo "  ⏳ Construyendo..."
npm run build || { echo "  ✗ Hubo un problema construyendo."; read -n 1 -s -r; exit 1; }
echo "  ✓ Construido."
echo ""

# 4) Abrir el navegador en el panel (con un pequeño retraso para que el server arranque).
( sleep 4; open "http://localhost:3000/admin/" ) &

# 5) Encender el sistema con datos de demostración.
echo "==================================================="
echo "   ✅ Listo. Abriendo el panel en tu navegador..."
echo ""
echo "   Panel:  http://localhost:3000/admin/"
echo "   App de bodega (PWA):  http://localhost:3000/app/"
echo ""
echo "   Inicia sesión con EMAIL y CONTRASEÑA (login real):"
echo "     root@ninjahubs.cl   / admin1234   → super-admin (ve todo)"
echo "     ana@ninjahubs.cl    / demo1234    → admin Bodega Ninja Hubs"
echo "     nora@andes.cl       / demo1234    → admin Bodega Andes"
echo "     carla@acme.cl       / demo1234    → cliente (solo ACME)"
echo ""
echo "   Para APAGAR: cierra esta ventana o presiona Control + C."
echo "==================================================="
echo ""

export SEED_DEMO=true
export PERSISTENCE=memory
# Autenticación real obligatoria (email + contraseña -> JWT).
export AUTH_REQUIRED=true
# Secreto para firmar los tokens. En un uso serio, cámbialo por uno propio.
export AUTH_SECRET="cambia-esto-en-produccion-$(hostname)"
node dist/src/main.js
