#!/usr/bin/env bash
# scripts/sifen-cert-prueba.sh · Genera un .p12 AUTOFIRMADO de PRUEBA para firmar localmente (MODO_SIMULADO)
# y para el escenario "certificado NO VÁLIDO" de la Guía de Pruebas e-kuatia §4.1.
# SIFEN NO lo acepta para aprobar documentos: para el ambiente de test real hace falta un certificado
# cualificado emitido por un PSC habilitado (MT v150 §7.5).
#
# Uso:  scripts/sifen-cert-prueba.sh [directorio_destino=/tmp] [RUC_sin_DV=80000000] [DV=0]
# Nunca escribe dentro del repo (el repo es público).
set -euo pipefail

DEST="${1:-/tmp}"
RUC="${2:-80000000}"
DV="${3:-0}"

command -v openssl >/dev/null || { echo "Falta openssl" >&2; exit 1; }
[[ "$RUC" =~ ^[0-9]{5,8}$ ]] || { echo "RUC inválido: $RUC" >&2; exit 1; }
[[ "$DV" =~ ^[0-9]$ ]] || { echo "DV inválido: $DV" >&2; exit 1; }

REPO_ABS="$(cd "$(dirname "$0")/.." && pwd -P)"
# Resolver la ruta ANTES de crear nada (ancestro existente más cercano + resto).
EXISTE="$DEST"; RESTO=""
while [ ! -d "$EXISTE" ]; do RESTO="/$(basename "$EXISTE")$RESTO"; EXISTE="$(dirname "$EXISTE")"; done
DEST_ABS="$(cd "$EXISTE" && pwd -P)$RESTO"
case "$DEST_ABS/" in
  "$REPO_ABS"/*) echo "Rechazado: $DEST_ABS está dentro del repo ($REPO_ABS). Usá /tmp u otra carpeta." >&2; exit 1 ;;
esac
mkdir -p "$DEST_ABS"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/sifen-cert.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
CLAVE="$(openssl rand -hex 12)"
SALIDA="$DEST_ABS/sifen-prueba-RUC${RUC}.p12"

# Subject con SerialNumber "RUCxxxxxxxx-x" (MT §7.5, OID 2.5.4.5), KeyUsage firma + no repudio
# (NT016 AC01) y EKU clientAuth (MT §7.5). RSA 2048 + SHA-256 (MT §7.7).
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
  -keyout "$TMP/clave.pem" -out "$TMP/cert.pem" \
  -subj "/C=PY/CN=VOLTRA PRUEBA SIN VALOR FISCAL/serialNumber=RUC${RUC}-${DV}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,nonRepudiation,keyEncipherment" \
  -addext "extendedKeyUsage=clientAuth" 2>/dev/null

# -legacy si está disponible (OpenSSL 3) para máxima compatibilidad; node-forge lee ambos formatos.
LEGACY=""
openssl pkcs12 -help 2>&1 | grep -q -- "-legacy" && LEGACY="-legacy"
openssl pkcs12 -export $LEGACY -inkey "$TMP/clave.pem" -in "$TMP/cert.pem" \
  -name "sifen-prueba" -out "$SALIDA" -passout "pass:$CLAVE"
chmod 600 "$SALIDA"

cat <<EOF
Listo: $SALIDA  (AUTOFIRMADO, solo pruebas locales)
Clave del .p12: $CLAVE

Cargarlo como variables (NO en archivos que van a Git):
  export SIFEN_CERT_P12_BASE64="\$(base64 -i '$SALIDA' | tr -d '\n')"
  export SIFEN_CERT_CLAVE='$CLAVE'
  export MODO_SIMULADO=1
Ver datos:  openssl pkcs12 -in '$SALIDA' -nokeys -passin 'pass:$CLAVE' $LEGACY | openssl x509 -noout -subject -enddate -ext extendedKeyUsage
EOF
