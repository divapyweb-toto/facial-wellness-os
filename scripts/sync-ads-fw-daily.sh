#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="/Users/enriqueramirez/Negocios"
FW_OS="$PROJECT_ROOT/fw-os"
LOG_FILE="$FW_OS/logs/sync-ads-fw.log"
CLAUDE_BIN="/Users/enriqueramirez/.local/bin/claude"
AD_ACCOUNT_ID="1075263797491391"

mkdir -p "$FW_OS/logs"

set -a
source "$FW_OS/.env"
source "$FW_OS/.env.local"
set +a

cd "$PROJECT_ROOT"

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
  "$CLAUDE_BIN" -p \
    "Sincronizá el gasto de ayer por ad set desde Meta Ads hacia gasto_ads_diario en Supabase. ad_account_id: ${AD_ACCOUNT_ID}." \
    --agent sync-ads-fw \
    --permission-mode bypassPermissions \
    --allowedTools "Bash,Read,ToolSearch,mcp__claude_ai_meta_ads__ads_get_ad_accounts,mcp__claude_ai_meta_ads__ads_get_ad_entities,mcp__claude_ai_meta_ads__ads_get_field_context"
  echo "===== fin $(date '+%Y-%m-%d %H:%M:%S') ====="
  echo
} >> "$LOG_FILE" 2>&1
