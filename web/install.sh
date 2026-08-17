#!/bin/sh

set -eu
umask 077
PATH=/usr/bin:/bin
export PATH

GITHUB_REPOSITORY=${QOS_GITHUB_REPOSITORY:-Quantized-OS/qOS}
DOWNLOAD_BASE=${QOS_DOWNLOAD_BASE:-https://github.com/${GITHUB_REPOSITORY}/releases/latest/download}
ARCHIVE_URL=${DOWNLOAD_BASE}/qos-source.tar.gz
CHECKSUM_URL=${DOWNLOAD_BASE}/SHA256SUMS.txt

usage() {
  cat <<'EOF'
qOS verified browser bootstrap

Usage:
  curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh
  curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh -s -- --devnet
  curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh -s -- --insecure

The bootstrap downloads the latest Quantized-OS/qOS GitHub Release source
archive and checksum, verifies the SHA-256 digest, installs an immutable
user-local source copy, and starts setup.sh install. All remaining arguments
are passed to setup.sh. With no arguments, the mainnet wizard first asks whether
to use your existing external key or generate a local key through --insecure.

For an independently pinned release, set QOS_RELEASE_SHA256 to the published
64-character archive digest before running this script.
EOF
}

case "${1-}" in
  -h|--help) usage; exit 0 ;;
esac

case "${GITHUB_REPOSITORY}" in
  ""|/*|*/|*/*/*|*[!A-Za-z0-9._/-]*)
    printf '%s\n' '[qOS bootstrap] ERROR: QOS_GITHUB_REPOSITORY must be OWNER/REPOSITORY.' >&2
    exit 1
    ;;
esac

case "${DOWNLOAD_BASE}" in
  https://*) ;;
  *)
    printf '%s\n' '[qOS bootstrap] ERROR: QOS_DOWNLOAD_BASE must use HTTPS.' >&2
    exit 1
    ;;
esac

for command_name in curl sha256sum tar awk sed mktemp diff find stat id; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf '[qOS bootstrap] ERROR: required command is unavailable: %s\n' "${command_name}" >&2
    exit 1
  }
done

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/qos-bootstrap.XXXXXX")
cleanup() {
  if [ -n "${temporary_directory-}" ] && [ -d "${temporary_directory}" ]; then
    find "${temporary_directory}" -type f -exec chmod u+w {} \; 2>/dev/null || true
    rm -rf -- "${temporary_directory}"
  fi
}
trap cleanup EXIT HUP INT TERM

archive=${temporary_directory}/qos-source.tar.gz
checksum=${temporary_directory}/SHA256SUMS.txt
printf '[qOS bootstrap] Downloading the latest release from https://github.com/%s.\n' "${GITHUB_REPOSITORY}"
if ! curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location \
  --silent --show-error --connect-timeout 20 --max-time 300 --max-filesize 268435456 \
  --output "${archive}" "${ARCHIVE_URL}"; then
  printf '%s\n' '[qOS bootstrap] ERROR: the latest GitHub Release does not provide qos-source.tar.gz.' >&2
  exit 1
fi

if [ -n "${QOS_RELEASE_SHA256-}" ]; then
  expected=${QOS_RELEASE_SHA256}
else
  if ! curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location \
    --silent --show-error --connect-timeout 20 --max-time 60 --max-filesize 65536 \
    --output "${checksum}" "${CHECKSUM_URL}"; then
    printf '%s\n' '[qOS bootstrap] ERROR: the latest GitHub Release does not provide SHA256SUMS.txt.' >&2
    exit 1
  fi
  expected=$(awk '$2 == "qos-source.tar.gz" { count += 1; value=$1 } END { if (count != 1) exit 3; print value }' "${checksum}") || {
    printf '%s\n' '[qOS bootstrap] ERROR: release checksum file is invalid.' >&2
    exit 1
  }
fi
printf '%s\n' "${expected}" | awk 'length($0) == 64 && $0 ~ /^[0-9a-f]+$/ { ok=1 } END { exit !ok }' || {
  printf '%s\n' '[qOS bootstrap] ERROR: release SHA-256 is invalid.' >&2
  exit 1
}
actual=$(sha256sum "${archive}" | awk '{print $1}')
if [ "${actual}" != "${expected}" ]; then
  printf '%s\n' '[qOS bootstrap] ERROR: source archive checksum mismatch.' >&2
  exit 1
fi
printf '[qOS bootstrap] Verified source SHA-256: %s\n' "${expected}"

tar -tzf "${archive}" | awk '
  BEGIN { good=1; root="" }
  {
    path=$0
    if (path ~ /^\// || path ~ /(^|\/)\.\.($|\/)/ || path ~ /(^|\/)\.($|\/)/) good=0
    split(path, parts, "/")
    if (root == "") root=parts[1]
    if (parts[1] != root) good=0
  }
  END { if (root !~ /^qos-[0-9]+\.[0-9]+\.[0-9]+$/) good=0; exit !good }
' || {
  printf '%s\n' '[qOS bootstrap] ERROR: source archive paths are unsafe.' >&2
  exit 1
}
tar -tvzf "${archive}" | awk 'substr($1,1,1) != "d" && substr($1,1,1) != "-" { exit 1 }' || {
  printf '%s\n' '[qOS bootstrap] ERROR: source archive contains links or special files.' >&2
  exit 1
}
tar -tvzf "${archive}" | awk '
  { count += 1; if ($3 ~ /^[0-9]+$/) total += $3 }
  count > 10000 || total > 536870912 { exit 1 }
' || {
  printf '%s\n' '[qOS bootstrap] ERROR: source archive expands beyond the safe file or size limit.' >&2
  exit 1
}

extract_directory=${temporary_directory}/extract
mkdir -m 0700 "${extract_directory}"
tar --extract --gzip --file "${archive}" --directory "${extract_directory}" \
  --no-same-owner --no-same-permissions
top_name=$(tar -tzf "${archive}" | sed -n '1s:/$::p')
source_directory=${extract_directory}/${top_name}
[ -f "${source_directory}/setup.sh" ] && [ -f "${source_directory}/package.json" ] || {
  printf '%s\n' '[qOS bootstrap] ERROR: verified archive is missing qOS setup files.' >&2
  exit 1
}

data_root=${XDG_DATA_HOME:-${HOME}/.local/share}
case "${data_root}" in
  /*) ;;
  *)
    printf '%s\n' '[qOS bootstrap] ERROR: XDG_DATA_HOME must be an absolute path.' >&2
    exit 1
    ;;
esac
release_root=${data_root}/qos/source/releases
target=${release_root}/${expected}
for managed_path in "${data_root}/qos" "${data_root}/qos/source" "${release_root}"; do
  if [ -L "${managed_path}" ]; then
    printf '[qOS bootstrap] ERROR: managed source path must not be a symbolic link: %s\n' "${managed_path}" >&2
    exit 1
  fi
done
if [ -e "${release_root}" ] && [ ! -d "${release_root}" ]; then
  printf '%s\n' '[qOS bootstrap] ERROR: qOS release path is not a directory.' >&2
  exit 1
fi
mkdir -p "${release_root}"
chmod 0700 "${data_root}/qos" "${data_root}/qos/source" "${release_root}" || {
  printf '%s\n' '[qOS bootstrap] ERROR: qOS source directories could not be made private.' >&2
  exit 1
}
[ "$(stat -c '%u' "${release_root}")" = "$(id -u)" ] || {
  printf '%s\n' '[qOS bootstrap] ERROR: qOS source directory is not owned by the current user.' >&2
  exit 1
}
release_mode=$(stat -c '%a' "${release_root}")
[ $((0${release_mode} & 0022)) -eq 0 ] || {
  printf '%s\n' '[qOS bootstrap] ERROR: qOS source directory is writable by group or other users.' >&2
  exit 1
}
if [ ! -e "${target}" ]; then
  mv -- "${source_directory}" "${target}"
  chmod 0700 "${target}"
else
  [ -d "${target}" ] && [ -f "${target}/setup.sh" ] || {
    printf '%s\n' '[qOS bootstrap] ERROR: existing verified-release path is unsafe.' >&2
    exit 1
  }
  [ "$(stat -c '%u' "${target}")" = "$(id -u)" ] || {
    printf '%s\n' '[qOS bootstrap] ERROR: existing verified release is not owned by the current user.' >&2
    exit 1
  }
  target_mode=$(stat -c '%a' "${target}")
  [ $((0${target_mode} & 0022)) -eq 0 ] || {
    printf '%s\n' '[qOS bootstrap] ERROR: existing verified release is writable by group or other users.' >&2
    exit 1
  }
  [ -z "$(find "${target}" \( -type l -o ! -type d ! -type f \) -print -quit)" ] || {
    printf '%s\n' '[qOS bootstrap] ERROR: existing verified release contains an unsafe file type.' >&2
    exit 1
  }
  diff --brief --recursive --no-dereference "${target}" "${source_directory}" >/dev/null || {
    printf '%s\n' '[qOS bootstrap] ERROR: existing release directory differs from the verified archive.' >&2
    exit 1
  }
fi

printf '[qOS bootstrap] Starting verified setup from %s\n' "${target}"
trap - EXIT HUP INT TERM
cleanup
temporary_directory=
if [ -r /dev/tty ]; then
  if [ "$#" -eq 0 ]; then
    exec bash "${target}/setup.sh" install --wizard < /dev/tty
  fi
  exec bash "${target}/setup.sh" install "$@" < /dev/tty
fi
exec bash "${target}/setup.sh" install "$@"
