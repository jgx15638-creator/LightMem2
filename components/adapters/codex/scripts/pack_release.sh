#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ADAPTER_DIR}/../../.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || command -v node.exe || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  printf '%s\n' "Node.js executable not found (expected node or node.exe)." >&2
  exit 1
fi
to_node_path() {
  if [[ "${NODE_BIN}" == *.exe ]] && command -v wslpath >/dev/null 2>&1; then
    local windows_path
    windows_path="$(wslpath -w "$1")"
    printf '%s\n' "${windows_path//\\//}"
  else
    printf '%s\n' "$1"
  fi
}
PNPM_CMD=(pnpm)
if command -v node.exe >/dev/null 2>&1 && command -v cmd.exe >/dev/null 2>&1; then
  PNPM_CMD=(cmd.exe /d /c pnpm)
fi

cd "${REPO_ROOT}"
"${PNPM_CMD[@]}" --filter @lightrsi/codex-adapter build >/dev/null
"${PNPM_CMD[@]}" --filter @lightrsi/cli build >/dev/null
"${PNPM_CMD[@]}" --filter @lightrsi/mcp build >/dev/null

PACK_TMP_DIR="$(mktemp -d "${ADAPTER_DIR}/.lightrsi-codex-pack-XXXXXX")"
cleanup() {
  rm -rf "${PACK_TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${PACK_TMP_DIR}/package/dist"
for file in index.js cli.js hooks-handler.js cleaner-mcp-server.js install-codex.js; do
  cp "${ADAPTER_DIR}/dist/${file}" "${PACK_TMP_DIR}/package/dist/${file}"
done
cp "${REPO_ROOT}/components/products/cli/dist/cli.js" "${PACK_TMP_DIR}/package/dist/lightrsi.js"
cp "${REPO_ROOT}/components/products/cli/dist/cli.js" "${PACK_TMP_DIR}/package/dist/lightmem2.js"
cp "${REPO_ROOT}/components/products/mcp/dist/server.js" "${PACK_TMP_DIR}/package/dist/mcp-server.js"
cp "${ADAPTER_DIR}/README.md" "${PACK_TMP_DIR}/package/README.md"

"${NODE_BIN}" - "$(to_node_path "${ADAPTER_DIR}")/package.json" "$(to_node_path "${PACK_TMP_DIR}/package")/package.json" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
delete manifest.dependencies;
delete manifest.devDependencies;
delete manifest.scripts;
manifest.files = ["dist", "README.md"];
fs.writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

NPM_CACHE_DIR="${NPM_CACHE_DIR:-${PACK_TMP_DIR}/npm-cache}"
if [[ "${NPM_CACHE_DIR}" == /* ]]; then
  mkdir -p "${NPM_CACHE_DIR}"
fi
archive_name="$(cd "${PACK_TMP_DIR}/package" && npm_config_cache="${NPM_CACHE_DIR}" npm pack --silent)"
archive_path="${ADAPTER_DIR}/${archive_name}"
cp "${PACK_TMP_DIR}/package/${archive_name}" "${archive_path}"
if command -v wslpath >/dev/null 2>&1; then
  archive_path="$(wslpath -w "${archive_path}")"
elif command -v cygpath >/dev/null 2>&1; then
  archive_path="$(cygpath -w "${archive_path}")"
fi
printf '%s\n' "${archive_path}"
