#!/usr/bin/env bash
set -Eeuo pipefail

PUBLIC_IP="${OVERLEAF_PUBLIC_IP:-124.223.191.114}"
PUBLIC_PORT="${OVERLEAF_PUBLIC_PORT:-8443}"
REMOTE_PORT="${OVERLEAF_REMOTE_PORT:-18081}"
FRPS_CONFIG="${FRPS_CONFIG:-/etc/frp/frps.toml}"
FRPS_SERVICE="${FRPS_SERVICE:-frps.service}"
NGINX_CONFIG="${OVERLEAF_NGINX_CONFIG:-/etc/nginx/conf.d/overleaf-frp.conf}"
CERT_FILE="${OVERLEAF_CERT_FILE:-}"
KEY_FILE="${OVERLEAF_KEY_FILE:-}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '\n== %s ==\n' "$*"; }

[[ "${EUID}" -eq 0 ]] || fail "Run with sudo: sudo ./deploy/cloud/setup.sh"
[[ "${PUBLIC_PORT}" =~ ^[0-9]+$ ]] || fail "OVERLEAF_PUBLIC_PORT must be a TCP port number."
[[ "${REMOTE_PORT}" =~ ^[0-9]+$ ]] || fail "OVERLEAF_REMOTE_PORT must be a TCP port number."
(( PUBLIC_PORT >= 1 && PUBLIC_PORT <= 65535 )) || fail "Invalid public port: ${PUBLIC_PORT}"
(( REMOTE_PORT >= 1 && REMOTE_PORT <= 65535 )) || fail "Invalid FRP remote port: ${REMOTE_PORT}"

command -v python3 >/dev/null || fail "python3 is required."
command -v nginx >/dev/null || fail "Nginx is not installed on this server."
command -v openssl >/dev/null || fail "openssl is required to validate the HTTPS certificate."
command -v ss >/dev/null || fail "ss (iproute2) is required to check the public port."
[[ -f "${FRPS_CONFIG}" ]] || fail "FRPS config not found: ${FRPS_CONFIG} (set FRPS_CONFIG to its path)."
systemctl is-active --quiet "${FRPS_SERVICE}" || fail "FRPS service ${FRPS_SERVICE} is not active (set FRPS_SERVICE if its unit has another name)."

if [[ -e "${NGINX_CONFIG}" ]] && ! grep -q '^# Managed by OFServer deploy/cloud/setup.sh\.' "${NGINX_CONFIG}"; then
    fail "${NGINX_CONFIG} already exists and is not managed by this script; move or review it before continuing."
fi
if [[ ! -e "${NGINX_CONFIG}" ]] && ss -H -ltn "sport = :${PUBLIC_PORT}" | grep -q .; then
    fail "TCP ${PUBLIC_PORT} is already in use. Choose another free public port that is open in the Tencent Cloud security group, for example OVERLEAF_PUBLIC_PORT=8443."
fi

info "Find a trusted certificate for ${PUBLIC_IP}"
if [[ -n "${CERT_FILE}" || -n "${KEY_FILE}" ]]; then
    [[ -n "${CERT_FILE}" && -n "${KEY_FILE}" ]] || fail "Set both OVERLEAF_CERT_FILE and OVERLEAF_KEY_FILE."
else
    readarray -t CERT_PAIR < <(python3 - "${PUBLIC_IP}" <<'PY'
import re
import subprocess
import sys

ip = sys.argv[1]
result = subprocess.run(["nginx", "-T"], capture_output=True, text=True)
text = result.stdout + "\n" + result.stderr
certs = re.findall(r"(?m)^\s*ssl_certificate\s+([^;]+);", text)
keys = re.findall(r"(?m)^\s*ssl_certificate_key\s+([^;]+);", text)
for cert, key in zip(certs, keys):
    cert, key = cert.strip().strip("\"'").split()[0], key.strip().strip("\"'").split()[0]
    if cert.startswith("$") or key.startswith("$"):
        continue
    check_ip = subprocess.run(["openssl", "x509", "-in", cert, "-noout", "-checkip", ip], capture_output=True)
    check_expiry = subprocess.run(["openssl", "x509", "-in", cert, "-noout", "-checkend", "0"], capture_output=True)
    if check_ip.returncode == 0 and check_expiry.returncode == 0:
        print(cert)
        print(key)
        break
PY
    )
    if (( ${#CERT_PAIR[@]} == 2 )); then
        CERT_FILE="${CERT_PAIR[0]}"
        KEY_FILE="${CERT_PAIR[1]}"
    elif [[ -r "/etc/letsencrypt/live/${PUBLIC_IP}/fullchain.pem" && -r "/etc/letsencrypt/live/${PUBLIC_IP}/privkey.pem" ]]; then
        CERT_FILE="/etc/letsencrypt/live/${PUBLIC_IP}/fullchain.pem"
        KEY_FILE="/etc/letsencrypt/live/${PUBLIC_IP}/privkey.pem"
    else
        fail "Could not find an existing certificate. Set OVERLEAF_CERT_FILE and OVERLEAF_KEY_FILE to a trusted certificate whose SAN contains ${PUBLIC_IP}."
    fi
fi

[[ -r "${CERT_FILE}" ]] || fail "Cannot read certificate: ${CERT_FILE}"
[[ -r "${KEY_FILE}" ]] || fail "Cannot read private key: ${KEY_FILE}"
openssl x509 -in "${CERT_FILE}" -noout -checkip "${PUBLIC_IP}" >/dev/null 2>&1 || fail "Certificate ${CERT_FILE} is not valid for IP ${PUBLIC_IP}."
openssl x509 -in "${CERT_FILE}" -noout -checkend 0 >/dev/null 2>&1 || fail "Certificate ${CERT_FILE} has expired."

install -d -m 0700 /var/backups/overleaf-frp
BACKUP_DIR="$(mktemp -d "/var/backups/overleaf-frp/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
cp -a "${FRPS_CONFIG}" "${BACKUP_DIR}/frps.toml"
if [[ -e "${NGINX_CONFIG}" ]]; then
    cp -a "${NGINX_CONFIG}" "${BACKUP_DIR}/overleaf-frp.conf"
fi
printf 'Backups: %s\n' "${BACKUP_DIR}"

info "Allow FRP remote port ${REMOTE_PORT}"
python3 - "${FRPS_CONFIG}" "${REMOTE_PORT}" <<'PY'
import re
import sys
import tomllib
from pathlib import Path

path = Path(sys.argv[1])
port = int(sys.argv[2])
text = path.read_text()
config = tomllib.loads(text)
if config.get("proxyBindAddr") != "127.0.0.1":
    raise SystemExit('FRPS must have proxyBindAddr = "127.0.0.1" so the relay port stays private.')

for rule in config.get("allowPorts", []):
    if rule.get("single") == port or rule.get("start", 1) <= port <= rule.get("end", 0):
        print(f"FRPS already allows port {port}; no change needed.")
        break
else:
    match = re.search(r"(?m)^[ \t]*allowPorts[ \t]*=[ \t]*\[", text)
    if match is None:
        entry = f"allowPorts = [{{ single = {port} }}]\n\n"
        table = re.search(r"(?m)^[ \t]*\[(?:\[)?[A-Za-z_\"]", text)
        if table:
            text = text[:table.start()] + entry + text[table.start():]
        else:
            text = text.rstrip() + "\n\n" + entry
    else:
        opening = text.find("[", match.start())
        depth = 0
        quote = None
        escaped = False
        closing = None
        index = opening
        while index < len(text):
            char = text[index]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
                index += 1
                continue
            if char in "\"'":
                quote = char
            elif char == "#":
                newline = text.find("\n", index)
                if newline < 0:
                    break
                index = newline + 1
                continue
            elif char == "[":
                depth += 1
            elif char == "]":
                depth -= 1
                if depth == 0:
                    closing = index
                    break
            index += 1
        if closing is None:
            raise SystemExit("Could not safely locate the end of FRPS allowPorts array; no changes made.")
        body = text[opening + 1:closing]
        addition = f"{{ single = {port} }}"
        if body.strip():
            separator = "\n    " if body.rstrip().endswith(",") else ",\n    "
            updated = body.rstrip() + separator + addition + "\n"
        else:
            updated = f"\n    {addition}\n"
        text = text[:opening + 1] + updated + text[closing:]
    tomllib.loads(text)
    path.write_text(text)
    print(f"Added FRPS allowPorts entry for {port}.")
PY

info "Install Nginx HTTPS listener on ${PUBLIC_PORT}"
install -d -m 0755 "$(dirname "${NGINX_CONFIG}")"
cat > "${NGINX_CONFIG}" <<EOF
# Managed by OFServer deploy/cloud/setup.sh. Local FRP only; do not expose 18081.
server {
    listen ${PUBLIC_PORT} ssl;
    server_name ${PUBLIC_IP};

    ssl_certificate     ${CERT_FILE};
    ssl_certificate_key ${KEY_FILE};

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:${REMOTE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$http_host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port  ${PUBLIC_PORT};
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
chmod 0644 "${NGINX_CONFIG}"

FRPS_BIN="$(command -v frps || true)"
[[ -n "${FRPS_BIN}" ]] || fail "frps binary is not in PATH; verify FRPS manually before restarting it."
"${FRPS_BIN}" verify -c "${FRPS_CONFIG}"
nginx -t
nginx -T 2>&1 | grep -F "# configuration file ${NGINX_CONFIG}:" >/dev/null || fail "Nginx is not loading ${NGINX_CONFIG}; check the server's include layout."

info "Restart FRPS and reload Nginx"
systemctl restart "${FRPS_SERVICE}"
systemctl reload nginx

printf '\nOverleaf cloud entry configured: https://%s:%s/\n' "${PUBLIC_IP}" "${PUBLIC_PORT}"
printf 'After the local FRPC proxy is added, verify: curl -i http://127.0.0.1:%s/status\n' "${REMOTE_PORT}"
printf 'Backup files are in %s\n' "${BACKUP_DIR}"
