#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly RUST_TARGET="riscv64imac-unknown-none-elf"
readonly MINIMUM_NODE_MAJOR=20
readonly DEFAULT_NODE_SERIES=22

node_setup_script=""
rustup_installer=""

log() {
  printf '[qOS setup] %s\n' "$*"
}

warn() {
  printf '[qOS setup] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[qOS setup] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${node_setup_script}" && -f "${node_setup_script}" ]]; then
    rm -f -- "${node_setup_script}"
  fi
  if [[ -n "${rustup_installer}" && -f "${rustup_installer}" ]]; then
    rm -f -- "${rustup_installer}"
  fi
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Linux" ]]; then
  die "This setup script requires Linux."
fi

if [[ ! -r /etc/os-release ]]; then
  die "Cannot identify the Linux distribution because /etc/os-release is unavailable."
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  warn "This script is tested on Ubuntu 20.04; detected ${PRETTY_NAME:-unknown Linux}."
elif [[ "${VERSION_ID:-}" != "20.04" ]]; then
  warn "This script targets Ubuntu 20.04; detected ${PRETTY_NAME:-Ubuntu}."
fi

privileged=()
if (( EUID != 0 )); then
  command -v sudo >/dev/null 2>&1 || die "sudo is required to install system packages."
  privileged=(sudo)
fi

run_privileged() {
  if ((${#privileged[@]})); then
    "${privileged[@]}" "$@"
  else
    "$@"
  fi
}

required_packages=(
  build-essential
  ca-certificates
  curl
  gnupg
  python3
  qemu-system-misc
)
missing_packages=()

for package_name in "${required_packages[@]}"; do
  if ! dpkg-query -W -f='${Status}' "${package_name}" 2>/dev/null | grep -q '^install ok installed$'; then
    missing_packages+=("${package_name}")
  fi
done

if ((${#missing_packages[@]})); then
  log "Installing Ubuntu packages: ${missing_packages[*]}"
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
else
  log "Ubuntu packages are already installed."
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
fi

if (( node_major < MINIMUM_NODE_MAJOR )); then
  node_series="${QOS_NODE_SERIES:-${DEFAULT_NODE_SERIES}}"
  [[ "${node_series}" =~ ^[0-9]+$ ]] || die "QOS_NODE_SERIES must be a whole-number Node.js release series."
  log "Installing Node.js ${node_series}.x from NodeSource."
  node_setup_script="$(mktemp /tmp/qos-nodesource.XXXXXX.sh)"
  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://deb.nodesource.com/setup_${node_series}.x" \
    -o "${node_setup_script}"
  run_privileged bash "${node_setup_script}"
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

command -v node >/dev/null 2>&1 || die "Node.js installation did not provide the node command."
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < MINIMUM_NODE_MAJOR )); then
  die "qOS requires Node.js ${MINIMUM_NODE_MAJOR} or newer; found $(node --version)."
fi

cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
if [[ -r "${cargo_home}/env" ]]; then
  # shellcheck disable=SC1090
  source "${cargo_home}/env"
fi

if ! command -v rustup >/dev/null 2>&1; then
  log "Installing the minimal Rust toolchain with rustup."
  rustup_installer="$(mktemp /tmp/qos-rustup.XXXXXX.sh)"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "${rustup_installer}"
  sh "${rustup_installer}" -s -- -y --profile minimal
  rm -f -- "${rustup_installer}"
  rustup_installer=""
  # shellcheck disable=SC1090
  source "${cargo_home}/env"
fi

command -v cargo >/dev/null 2>&1 || die "Cargo is unavailable after installing Rust."
command -v rustup >/dev/null 2>&1 || die "rustup is unavailable after installation."

if ! rustup target list --installed | grep -Fxq "${RUST_TARGET}"; then
  log "Installing the bare-metal RISC-V Rust target."
  rustup target add "${RUST_TARGET}"
else
  log "Rust target ${RUST_TARGET} is already installed."
fi

log "Writing the firmware Cargo target configuration."
mkdir -p "${PROJECT_ROOT}/firmware-demo/.cargo"
tee "${PROJECT_ROOT}/firmware-demo/.cargo/config.toml" >/dev/null <<'EOF'
[build]
target = "riscv64imac-unknown-none-elf"

[target.riscv64imac-unknown-none-elf]
rustflags = [
  "-C", "link-arg=-Tlinker.ld",
  "-C", "link-arg=--gc-sections",
]
EOF
chmod 0644 "${PROJECT_ROOT}/firmware-demo/.cargo/config.toml"

command -v qemu-system-riscv64 >/dev/null 2>&1 || die "qemu-system-riscv64 was not installed by qemu-system-misc."
command -v make >/dev/null 2>&1 || die "make is unavailable after installing build-essential."
command -v python3 >/dev/null 2>&1 || die "Python 3 is unavailable after installation."

log "Setup complete."
log "Node: $(node --version)"
log "Rust: $(rustc --version)"
log "Cargo: $(cargo --version)"
log "QEMU: $(qemu-system-riscv64 --version | sed -n '1p')"

