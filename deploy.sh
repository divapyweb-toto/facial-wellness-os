#!/bin/bash
set -e
MSG=${1:-"update"}

echo "🔄 Restaurando index.html desde fuente protegida..."
cp _index.html index.html

echo "🔨 Buildeando..."
npm run build

echo "📦 Preparando archivos para GitHub Pages..."
rm -rf assets
cp -r dist/assets ./assets
cp dist/index.html ./index.html
[ -f public/apple-touch-icon.png ] && cp public/apple-touch-icon.png .
[ -f public/favicon.png ] && cp public/favicon.png .

echo "🚀 Subiendo a GitHub..."
git add -f index.html assets/
git add -f _index.html vite.config.js deploy.sh src/ 2>/dev/null || true
[ -f apple-touch-icon.png ] && git add -f apple-touch-icon.png
[ -f favicon.png ] && git add -f favicon.png

git diff --staged --quiet && echo "⚠️ Sin cambios" || git commit -m "$MSG"
git push origin main --force-with-lease 2>/dev/null || git push origin main --force

echo "✅ $MSG"
echo "🌐 https://divapyweb-toto.github.io/facial-wellness-os/"
