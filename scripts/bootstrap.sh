#!/usr/bin/env bash
set -euo pipefail

MODE="native"
CLIENT="none"
NO_MIGRATE="false"
SKIP_MCP_INSTALL="false"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage: scripts/bootstrap.sh [--mode native|docker] [--client none|claude|codex|cursor|all] [--no-migrate] [--skip-mcp-install]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
    --client)
      CLIENT="${2:-}"
      shift 2
      ;;
    --client=*)
      CLIENT="${1#--client=}"
      shift
      ;;
    --no-migrate)
      NO_MIGRATE="true"
      shift
      ;;
    --skip-mcp-install)
      SKIP_MCP_INSTALL="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

step() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  local name="$1"
  local hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required. $hint" >&2
    exit 1
  fi
}

new_hex_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  else
    echo "openssl or python3 is required to generate secrets" >&2
    exit 1
  fi
}

get_env_file_value() {
  local env_path="$1"
  local key="$2"
  local line=""
  local value=""

  line="$(grep -Ei "^[[:space:]]*${key}[[:space:]]*=" "$env_path" 2>/dev/null | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi

  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [[ ${#value} -ge 2 ]]; then
    local first="${value:0:1}"
    local last="${value: -1}"
    if [[ "$first" == '"' && "$last" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$first" == "'" && "$last" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  echo "$value"
}

ensure_docker_env() {
  local env_path="$REPO_ROOT/.env"
  if [[ -f "$env_path" ]]; then
    echo "Using existing .env: $env_path"
    local db_password
    local api_keys
    db_password="$(get_env_file_value "$env_path" "DB_PASSWORD")"
    api_keys="$(get_env_file_value "$env_path" "SCG_API_KEYS")"
    if [[ -z "$db_password" || "$db_password" =~ ^([Pp][Oo][Ss][Tt][Gg][Rr][Ee][Ss]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Cc][Hh][Aa][Nn][Gg][Ee][Mm][Ee]|change_me_before_deploying|change-me-before-deploying|change_me_before_running|change-me-before-running)$ ]]; then
      echo "Existing .env has a missing or weak DB_PASSWORD. Replace it with a strong generated value before Docker startup." >&2
      exit 1
    fi
    if [[ -z "$api_keys" || "$api_keys" == "your-secret-key-here" ]]; then
      echo "Existing .env has missing or weak SCG_API_KEYS. Set at least one 32+ character API key before Docker startup." >&2
      exit 1
    fi
    IFS=',' read -ra key_parts <<< "$api_keys"
    for key in "${key_parts[@]}"; do
      key="${key#"${key%%[![:space:]]*}"}"
      key="${key%"${key##*[![:space:]]}"}"
      if [[ ${#key} -lt 32 ]]; then
        echo "Existing .env has an SCG_API_KEYS entry shorter than 32 characters." >&2
        exit 1
      fi
    fi
    return
  fi

  local api_key
  local db_password
  api_key="$(new_hex_secret)"
  db_password="$(new_hex_secret)"
  cat > "$env_path" <<EOF
# ContextZero Docker bootstrap configuration
DB_PASSWORD=$db_password
SCG_API_KEYS=$api_key
SCG_REPOS_PATH=.
SCG_ALLOWED_BASE_PATHS=/repos
SCG_MAX_FILES_PER_REPO=20000
SCG_MAX_FILE_SIZE_BYTES=1048576
SCG_INGEST_WORKERS=4
SCG_PYTHON_TIMEOUT_MS=30000
DB_SSL_ALLOW_INSECURE_PRIVATE_NETWORK=true
EOF
  echo "Created Docker .env with generated secrets: $env_path"
}

install_python_dependency() {
  local python_bin=""
  if command -v python3 >/dev/null 2>&1; then
    python_bin="python3"
  elif command -v python >/dev/null 2>&1; then
    python_bin="python"
  fi

  if [[ -z "$python_bin" ]]; then
    echo "Python was not found. Python files will fail extraction until Python 3 and libcst are installed."
    return
  fi

  step "Installing Python LibCST dependency"
  "$python_bin" -m pip install --user libcst
}

ensure_postgres_best_effort() {
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql was not found. Skipping database creation; npm run doctor will report exact DB status."
    return
  fi

  step "Preparing PostgreSQL database when local tools allow it"
  if command -v createdb >/dev/null 2>&1; then
    createdb scg_v2 2>/dev/null || echo "createdb scg_v2 skipped or already exists."
  fi

  psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null || \
    echo "Could not verify pg_trgm with psql. npm run doctor will give the exact database fix."
}

case "$MODE" in
  docker)
    step "Bootstrapping ContextZero with Docker Compose"
    require_command docker "Install Docker Desktop or Docker Engine, then rerun this script."
    ensure_docker_env
    docker compose up -d --build
    docker compose ps
    echo ""
    echo "Docker mode is running. REST health: http://localhost:3100/health"
    exit 0
    ;;
  native)
    ;;
  *)
    echo "Invalid --mode value: $MODE" >&2
    usage
    exit 2
    ;;
esac

step "Bootstrapping ContextZero natively"
require_command node "Install Node.js 20 or newer."
require_command npm "Install Node.js 20 or newer; npm is included with Node."

install_python_dependency
ensure_postgres_best_effort

step "Installing Node dependencies"
npm install

step "Running ContextZero setup"
if [[ "$NO_MIGRATE" == "true" ]]; then
  npm run setup
else
  npm run setup -- --migrate
fi

if [[ "$SKIP_MCP_INSTALL" != "true" && "$CLIENT" != "none" ]]; then
  step "Installing MCP config for $CLIENT"
  npm run mcp:install -- --client "$CLIENT"
fi

echo ""
echo "Bootstrap complete. Run npm run doctor any time to re-check the machine."
