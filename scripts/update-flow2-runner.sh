#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY="git@github.com:cloud-cli/on.git"
readonly BRANCH="dev"
readonly ROOT="/opt/on/runner-releases"
readonly UNIT="runner-worker-flow2.service"
readonly DROPIN_DIR="/etc/systemd/system/${UNIT}.d"
readonly DROPIN="${DROPIN_DIR}/20-source-build.conf"
readonly LOCK="/run/lock/update-flow2-runner.lock"

exec 9>"${LOCK}"
if ! flock -n 9; then
  echo "Another Flow2 runner update is already running; skipping."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release="${ROOT}/${timestamp}"
previous=""
if [[ -f "${DROPIN}" ]]; then
  previous="$(sed -n 's|^WorkingDirectory=||p' "${DROPIN}" | tail -n1)"
fi

cleanup_on_error() {
  local status=$?
  if (( status != 0 )); then
    if [[ -n "${previous}" && -d "${previous}" ]]; then
      write_dropin "${previous}"
      systemctl daemon-reload
      systemctl restart "${UNIT}" || true
    fi
    rm -rf -- "${release}"
  fi
  exit "${status}"
}
trap cleanup_on_error EXIT

write_dropin() {
  local dir="$1"
  install -d -m 0755 "${DROPIN_DIR}"
  local temp
  temp="$(mktemp "${DROPIN_DIR}/.20-source-build.XXXXXX")"
  cat >"${temp}" <<EOF
[Service]
WorkingDirectory=${dir}
ExecStart=
ExecStart=$(command -v node) ${dir}/dist/worker.js
TimeoutStopSec=1h
EOF
  chmod 0644 "${temp}"
  mv -f "${temp}" "${DROPIN}"
}

install -d -m 0755 "${ROOT}"
git clone --quiet --depth 1 --branch "${BRANCH}" "${REPOSITORY}" "${release}"
cd "${release}"
pnpm install --frozen-lockfile
pnpm test:worker-artifact

write_dropin "${release}"
systemctl daemon-reload
systemctl restart "${UNIT}"
for _ in {1..30}; do
  if [[ "$(systemctl is-active "${UNIT}")" == "active" ]]; then
    break
  fi
  sleep 2
done
[[ "$(systemctl is-active "${UNIT}")" == "active" ]]
systemctl show "${UNIT}" -p MainPID -p NRestarts -p ActiveState
journalctl -u "${UNIT}" -n 20 --no-pager

trap - EXIT
echo "Flow2 runner updated from ${BRANCH} to $(git rev-parse --short HEAD) at ${release}"
