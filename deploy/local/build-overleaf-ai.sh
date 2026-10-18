#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLKIT_DIR="${OVERLEAF_TOOLKIT_DIR:-/opt/overleaf/toolkit}"
IMAGE_NAME="ofserver/overleaf-ai"
BACKUP_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '\n== %s ==\n' "$*"; }

[[ "${EUID}" -eq 0 ]] || fail "Run with sudo: sudo ./deploy/local/build-overleaf-ai.sh"
[[ -x "${TOOLKIT_DIR}/bin/up" ]] || fail "Overleaf Toolkit not found at ${TOOLKIT_DIR}; set OVERLEAF_TOOLKIT_DIR."
[[ -f "${TOOLKIT_DIR}/config/version" ]] || fail "Toolkit version file is missing."
[[ -f "${TOOLKIT_DIR}/config/overleaf.rc" ]] || fail "Toolkit config/overleaf.rc is missing."
[[ -f "${TOOLKIT_DIR}/config/variables.env" ]] || fail "Toolkit config/variables.env is missing."

IMAGE_VERSION="$(<"${TOOLKIT_DIR}/config/version")"
[[ "${IMAGE_VERSION}" == "6.3.1-with-texlive-full" ]] || fail "This integration is pinned to Overleaf 6.3.1-with-texlive-full; found ${IMAGE_VERSION}."

if ! grep -q '^OVERLEAF_AI_SETTINGS_SECRET=' "${TOOLKIT_DIR}/config/variables.env"; then
    info "Create the persistent AI settings encryption secret"
    cp -a "${TOOLKIT_DIR}/config/variables.env" "${TOOLKIT_DIR}/config/variables.env.bak-ai-${BACKUP_SUFFIX}"
    printf '\n# Encryption key for DeepSeek credentials stored in MongoDB. Back up this value with the Toolkit config.\nOVERLEAF_AI_SETTINGS_SECRET=%s\n' "$(openssl rand -hex 32)" >> "${TOOLKIT_DIR}/config/variables.env"
fi

info "Build the customized Overleaf image"
docker build \
    --build-arg "BASE_IMAGE=sharelatex/sharelatex@sha256:eb8c3156339a8f292dc5d087c2add45d7a30b4d9e387d6c4fdf612ecc079ad6f" \
    --tag "${IMAGE_NAME}:${IMAGE_VERSION}" \
    --file "${REPO_ROOT}/overleaf-ai/Dockerfile" \
    "${REPO_ROOT}/overleaf-ai"

info "Point the Toolkit at the customized image"
CONFIG="${TOOLKIT_DIR}/config/overleaf.rc"
BACKUP="${CONFIG}.bak-ai-${BACKUP_SUFFIX}"
cp -a "${CONFIG}" "${BACKUP}"
if grep -q '^OVERLEAF_IMAGE_NAME=' "${CONFIG}"; then
    sed -i "s|^OVERLEAF_IMAGE_NAME=.*|OVERLEAF_IMAGE_NAME=${IMAGE_NAME}|" "${CONFIG}"
elif grep -q '^# OVERLEAF_IMAGE_NAME=' "${CONFIG}"; then
    sed -i "s|^# OVERLEAF_IMAGE_NAME=.*|OVERLEAF_IMAGE_NAME=${IMAGE_NAME}|" "${CONFIG}"
else
    printf '\nOVERLEAF_IMAGE_NAME=%s\n' "${IMAGE_NAME}" >> "${CONFIG}"
fi

printf '\nBuilt %s:%s\nToolkit config backup: %s\n' "${IMAGE_NAME}" "${IMAGE_VERSION}" "${BACKUP}"
if [[ -f "${TOOLKIT_DIR}/config/variables.env.bak-ai-${BACKUP_SUFFIX}" ]]; then
    printf 'Variables backup: %s\n' "${TOOLKIT_DIR}/config/variables.env.bak-ai-${BACKUP_SUFFIX}"
fi
printf 'Apply the image with: cd %q && bin/up -d\n' "${TOOLKIT_DIR}"
