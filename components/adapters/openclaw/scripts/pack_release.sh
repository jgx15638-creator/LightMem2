#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_CMD=(npm run build)
if command -v node.exe >/dev/null 2>&1 && command -v cmd.exe >/dev/null 2>&1; then
  # A repository mounted into WSL may have dependencies installed by Windows.
  # Use the matching Windows Node toolchain without depending on a globally
  # selected pnpm version; this package's build has no workspace orchestration.
  BUILD_CMD=(cmd.exe /d /c npm run build)
fi

cd "${PLUGIN_DIR}"

rm -f lightrsi-openclaw-adapter-*.tgz lightrsi-tokenpilot-openclaw-*.tgz tokenpilot-*.tgz
# install_release.sh captures stdout from this script as the archive path.
# Keep build diagnostics visible on stderr while reserving stdout for the
# final .tgz path printed below.
"${BUILD_CMD[@]}" >&2

PACK_TMP_DIR="$(mktemp -d "${PLUGIN_DIR}/.tokenpilot-pack-XXXXXX")"
cleanup() {
  rm -rf "${PACK_TMP_DIR}"
}
trap cleanup EXIT

NPM_CACHE_DIR="${NPM_CACHE_DIR:-${PACK_TMP_DIR}/npm-cache}"
if command -v wslpath >/dev/null 2>&1; then
  case "${NPM_CACHE_DIR}" in
    [A-Za-z]:[\\/]*) NPM_CACHE_DIR="$(wslpath -u "${NPM_CACHE_DIR}")" ;;
  esac
elif command -v cygpath >/dev/null 2>&1; then
  case "${NPM_CACHE_DIR}" in
    [A-Za-z]:[\\/]*) NPM_CACHE_DIR="$(cygpath -u "${NPM_CACHE_DIR}")" ;;
  esac
fi
if [[ "${NPM_CACHE_DIR}" == /* ]]; then
  mkdir -p "${NPM_CACHE_DIR}"
fi

mkdir -p "${PACK_TMP_DIR}/package"
cp -R dist "${PACK_TMP_DIR}/package/dist"
cp README.md "${PACK_TMP_DIR}/package/README.md"
cp openclaw.plugin.json "${PACK_TMP_DIR}/package/openclaw.plugin.json"

python3 - "${PLUGIN_DIR}/package.json" "${PACK_TMP_DIR}/package/package.json" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
pkg = json.loads(src.read_text(encoding="utf-8"))

# Release tarball is fully bundled in dist/index.js. Workspace deps make
# OpenClaw try to npm install inside the extracted plugin directory, which
# fails outside the monorepo. Strip runtime/dev deps for the packed artifact.
pkg.pop("dependencies", None)
pkg.pop("devDependencies", None)
pkg.pop("scripts", None)

dst.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY

archive_name="$(cd "${PACK_TMP_DIR}/package" && npm_config_cache="${NPM_CACHE_DIR}" npm pack --silent)"
archive_path="${PACK_TMP_DIR}/package/${archive_name}"
cp "${archive_path}" "${PLUGIN_DIR}/${archive_name}"
archive_path="${PLUGIN_DIR}/${archive_name}"
if command -v wslpath >/dev/null 2>&1; then
  archive_path="$(wslpath -w "${archive_path}")"
elif command -v cygpath >/dev/null 2>&1; then
  archive_path="$(cygpath -w "${archive_path}")"
fi

printf '%s\n' "${archive_path}"
