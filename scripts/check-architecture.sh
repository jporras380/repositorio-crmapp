#!/usr/bin/env bash
# Guardas de arquitectura del ARCH. Corren en CI y fallan la build.
#
# No sustituyen a los tests: son la red que atrapa el error de escritura,
# no el error de diseño. Cada guarda cita la sección del ARCH que protege.
set -uo pipefail

fallos=0

fallar() {
  echo "FALLO: $1"
  echo "       $2"
  fallos=$((fallos + 1))
}

buscar() {
  # $1 patrón · $2 rutas · devuelve 0 si hay coincidencias
  grep -rInE "$1" $2 --include='*.ts' --include='*.tsx' 2>/dev/null
}

echo "== Guardas de arquitectura =="

# --- §6 del ARCH · ADR-005 -------------------------------------------------
# Un SET sin LOCAL sobrevive a la transacción. Con pooler en modo transacción
# se filtra a la siguiente petición que reciba esa conexión: fuga entre
# inquilinos. Es el bug que convierte la decisión de RLS en una brecha.
if hits=$(buscar "SET[[:space:]]+app\.tenant_id" "apps packages"); then
  if echo "$hits" | grep -qvE "SET[[:space:]]+LOCAL"; then
    fallar "'SET app.tenant_id' sin LOCAL" "ARCH §6 / ADR-005. Usa SET LOCAL, siempre."
    echo "$hits" | grep -vE "SET[[:space:]]+LOCAL"
  fi
fi

# --- §4 del ARCH -----------------------------------------------------------
# core es dominio puro. Si importa I/O, la lógica de negocio deja de ser
# portable y acaba duplicada en el frontend, que es justo lo que el
# requisito "cero lógica de negocio en el frontend" prohíbe.
if [ -d packages/core ]; then
  if hits=$(buscar "from '(pg|ioredis|bullmq|axios|node:fs|node:net|@aws-sdk)" "packages/core"); then
    fallar "packages/core importa I/O" "ARCH §4. core es dominio puro, sin I/O."
    echo "$hits"
  fi
fi

# --- §8 del ARCH -----------------------------------------------------------
# El núcleo habla con ChannelAdapter, no con un canal concreto. Si alguien
# importa el adaptador de WhatsApp desde fuera, el cuarto canal obliga a
# tocar el núcleo, y ese contrato está en la lista de parada.
if hits=$(grep -rInE "channels/(whatsapp|instagram|tiktok)" apps packages --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v '^packages/channels/'); then
  fallar "canal concreto importado fuera de packages/channels" "ARCH §8. El núcleo usa ChannelAdapter."
  echo "$hits"
fi

# --- §9 del ARCH -----------------------------------------------------------
# Un mensaje sale por un solo sitio: la puerta de packages/envio. Si alguien
# inserta un saliente por su cuenta, se salta la ventana de 24 h, el estado de
# la suscripción y el outbox, y eso no se nota hasta que llega la factura de
# Meta o un cliente reporta el número.
if hits=$(grep -rl "INSERT INTO messages" apps packages --include='*.ts' 2>/dev/null); then
  for archivo in $hits; do
    case "$archivo" in
      # Los tests siembran mensajes a mano: es su trabajo fabricar el estado
      # de partida, no atravesar la puerta.
      packages/envio/* | */test/* | */tests/*) continue ;;
    esac
    if grep -q "'outbound'" "$archivo"; then
      fallar "saliente insertado fuera de la puerta de envío: $archivo"         "ARCH §9. Usa enviarPorConversacion de @crmapp/envio."
    fi
  done
fi

# --- §11 del ARCH ----------------------------------------------------------
# Estilo de la web solo en CSS aparte (ADR-010): nada en línea ni CSS-in-JS.
if [ -d apps/web/src ]; then
  if hits=$(grep -rnE "style=\{\{" apps/web/src --include='*.tsx' 2>/dev/null); then
    fallar "estilos en línea en apps/web" "ADR-010. Todo estilo va en el .module.css del componente."
    echo "$hits"
  fi
  if hits=$(grep -rnE "from '(styled-components|@emotion/[a-z]+|@stitches/[a-z]+|@vanilla-extract/[a-z]+)'" apps/web/src 2>/dev/null); then
    fallar "CSS-in-JS en apps/web" "ADR-010. La convención del usuario lo excluye."
    echo "$hits"
  fi
  if hits=$(grep -rnE "from '@crmapp/(core|db|channels|queue|crypto)'" apps/web/src 2>/dev/null); then
    fallar "apps/web importa lógica de negocio" "ARCH §3. La web pinta estado; no lo decide."
    echo "$hits"
  fi
fi

# Cero credenciales en el repositorio. .env.example lleva nombres, no valores.
if [ -f .env.example ]; then
  if hits=$(grep -nE '^[A-Z_][A-Z0-9_]*=.+' .env.example); then
    fallar ".env.example contiene valores" "ARCH §11. Solo nombres de variable."
    echo "$hits"
  fi
fi

echo
if [ "$fallos" -eq 0 ]; then
  echo "OK: $(basename "$0") sin hallazgos."
  exit 0
fi
echo "$fallos guarda(s) incumplida(s)."
exit 1
