#!/bin/sh

set -eu
umask 077
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

QOS_LIMA_INSTANCE=${QOS_LIMA_INSTANCE:-qos}
QOS_BOOTSTRAP_URL=${QOS_BOOTSTRAP_URL:-https://qos.systems/install.sh}

usage() {
  cat <<'EOF'
qOS macOS installer

Usage:
  curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh
  curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh -s -- --devnet
  curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh -s -- --insecure

qOS currently targets Ubuntu. This wrapper installs Lima with Homebrew when
needed, creates an isolated Ubuntu 24.04 VM named "qos", and runs the verified
qOS GitHub Release bootstrap inside it. Setup arguments are forwarded unchanged.
With no arguments, setup asks whether to use your existing external key or
generate a local key through --insecure.

Requirements:
  - macOS
  - Homebrew (https://brew.sh)

After setup, reopen qOS with:
  limactl shell qos bash -lc qos
EOF
}

case "${1-}" in
  -h|--help) usage; exit 0 ;;
esac

if [ "$(uname -s 2>/dev/null || true)" != Darwin ]; then
  printf '%s\n' '[qOS macOS] ERROR: this installer must run on macOS.' >&2
  exit 1
fi

case "${QOS_LIMA_INSTANCE}" in
  ""|*[!A-Za-z0-9._-]*)
    printf '%s\n' '[qOS macOS] ERROR: QOS_LIMA_INSTANCE contains unsupported characters.' >&2
    exit 1
    ;;
esac
case "${QOS_BOOTSTRAP_URL}" in
  https://*) ;;
  *)
    printf '%s\n' '[qOS macOS] ERROR: QOS_BOOTSTRAP_URL must use HTTPS.' >&2
    exit 1
    ;;
esac

if ! command -v limactl >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    cat >&2 <<'EOF'
[qOS macOS] ERROR: Homebrew is required to install the Lima Ubuntu runtime.
Install Homebrew from https://brew.sh, then run the qOS command again.
qOS does not silently execute a second third-party bootstrap as root.
EOF
    exit 1
  fi
  printf '%s\n' '[qOS macOS] Installing the Lima Ubuntu runtime with Homebrew.'
  brew install lima
fi

if limactl info "${QOS_LIMA_INSTANCE}" >/dev/null 2>&1; then
  printf '[qOS macOS] Reusing isolated VM %s.\n' "${QOS_LIMA_INSTANCE}"
else
  printf '[qOS macOS] Creating isolated Ubuntu VM %s (4 CPU, 4 GiB RAM, 32 GiB disk).\n' "${QOS_LIMA_INSTANCE}"
  limactl start --name="${QOS_LIMA_INSTANCE}" --cpus=4 --memory=4 --disk=32 \
    --mount-none --tty=false template:ubuntu-24.04
fi

guest_identity=$(limactl shell --start --tty=false "${QOS_LIMA_INSTANCE}" sh -lc \
  '. /etc/os-release; printf "%s|%s" "$ID" "$VERSION_ID"')
case "${guest_identity}" in
  ubuntu\|20.04|ubuntu\|22.04|ubuntu\|24.04) ;;
  *)
    printf '[qOS macOS] ERROR: VM %s is not a supported Ubuntu release (found %s).\n' \
      "${QOS_LIMA_INSTANCE}" "${guest_identity}" >&2
    printf '%s\n' '[qOS macOS] Choose a new name with QOS_LIMA_INSTANCE or inspect the existing VM.' >&2
    exit 1
    ;;
esac

printf '%s\n' '[qOS macOS] Starting the verified qOS setup inside Ubuntu.'
limactl shell --start --tty=true "${QOS_LIMA_INSTANCE}" bash -lc '
  set -eu
  bootstrap_url=$1
  release_sha=$2
  download_base=$3
  repository=$4
  shift 4
  if ! command -v curl >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl
  fi
  [ -z "$release_sha" ] || export QOS_RELEASE_SHA256=$release_sha
  [ -z "$download_base" ] || export QOS_DOWNLOAD_BASE=$download_base
  [ -z "$repository" ] || export QOS_GITHUB_REPOSITORY=$repository
  curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL "$bootstrap_url" | sh -s -- "$@"
' qos-macos-bootstrap "${QOS_BOOTSTRAP_URL}" "${QOS_RELEASE_SHA256-}" \
  "${QOS_DOWNLOAD_BASE-}" "${QOS_GITHUB_REPOSITORY-}" "$@"

printf '\n[qOS macOS] Reopen qOS with:\n  limactl shell %s bash -lc qos\n' "${QOS_LIMA_INSTANCE}"
