#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly RUST_TARGET="riscv64imac-unknown-none-elf"
readonly RUST_TOOLCHAIN="1.97.1"
readonly MINIMUM_NODE_MAJOR=20
readonly NODE_VERSION="24.19.0"

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

usage() {
  cat <<'EOF'
Usage: scripts/setup-ubuntu-20.04.sh [--install-toolchains]

Install Ubuntu packages and verify the qOS build dependencies. With
--install-toolchains, also install the pinned user-local Node.js and Rust
toolchains using verified official artifacts.
EOF
}

install_toolchains=0
while (($#)); do
  case "$1" in
    --install-toolchains)
      install_toolchains=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  die "This setup script requires Linux."
fi

if [[ ! -r /etc/os-release ]]; then
  die "Cannot identify the Linux distribution because /etc/os-release is unavailable."
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  warn "This script supports Ubuntu 20.04, 22.04, and 24.04; detected ${PRETTY_NAME:-unknown Linux}."
elif [[ "${VERSION_ID:-}" != "20.04" && "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
  warn "This script supports Ubuntu 20.04, 22.04, and 24.04; detected ${PRETTY_NAME:-Ubuntu}."
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
  xz-utils
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

if (( install_toolchains )); then
  "${SCRIPT_DIR}/bootstrap-user-toolchain.sh"
  case "$(uname -m)" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) die "The verified user toolchain supports x86_64 and aarch64." ;;
  esac
  toolchain_root="${QOS_TOOLCHAIN_ROOT:-${HOME}/.local/share/qos/toolchains}"
  export CARGO_HOME="${toolchain_root}/cargo"
  export RUSTUP_HOME="${toolchain_root}/rustup"
  export PATH="${toolchain_root}/node-v${NODE_VERSION}-linux-${node_arch}/bin:${CARGO_HOME}/bin:${PATH}"
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
fi

if (( node_major < MINIMUM_NODE_MAJOR )); then
  die "Install Node.js ${MINIMUM_NODE_MAJOR} or newer from a verified, pinned package source before running this script. qOS does not download and execute remote bootstrap scripts."
fi

command -v node >/dev/null 2>&1 || die "Node.js installation did not provide the node command."
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < MINIMUM_NODE_MAJOR )); then
  die "qOS requires Node.js ${MINIMUM_NODE_MAJOR} or newer; found $(node --version)."
fi

cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
export PATH="${cargo_home}/bin:${PATH}"

if ! command -v rustup >/dev/null 2>&1; then
  die "Install rustup from a verified, pinned package before running this script. qOS does not download and execute remote bootstrap scripts."
fi

command -v cargo >/dev/null 2>&1 || die "Cargo is unavailable after installing Rust."
command -v rustup >/dev/null 2>&1 || die "rustup is unavailable after installation."

if ! rustup toolchain list | grep -Eq "^${RUST_TOOLCHAIN}(-|[[:space:]])"; then
  log "Installing the pinned Rust ${RUST_TOOLCHAIN} toolchain."
  rustup toolchain install "${RUST_TOOLCHAIN}" --profile minimal
else
  log "Rust ${RUST_TOOLCHAIN} is already installed."
fi

if ! rustup target list --installed --toolchain "${RUST_TOOLCHAIN}" | grep -Fxq "${RUST_TARGET}"; then
  log "Installing the bare-metal RISC-V Rust target."
  rustup target add --toolchain "${RUST_TOOLCHAIN}" "${RUST_TARGET}"
else
  log "Rust target ${RUST_TARGET} is already installed."
fi

[[ "$(rustup run "${RUST_TOOLCHAIN}" rustc --version)" == rustc\ ${RUST_TOOLCHAIN}\ * ]] \
  || die "The selected Rust compiler does not match ${RUST_TOOLCHAIN}."

[[ -r "${PROJECT_ROOT}/firmware-demo/.cargo/config.toml" ]] || die "Committed Cargo target configuration is missing."
[[ -r "${PROJECT_ROOT}/rust-toolchain.toml" ]] || die "Committed Rust toolchain pin is missing."

command -v qemu-system-riscv64 >/dev/null 2>&1 || die "qemu-system-riscv64 was not installed by qemu-system-misc."
command -v make >/dev/null 2>&1 || die "make is unavailable after installing build-essential."
command -v python3 >/dev/null 2>&1 || die "Python 3 is unavailable after installation."

log "Setup complete."
log "Node: $(node --version)"
log "Rust: $(rustc --version)"
log "Cargo: $(cargo --version)"
log "QEMU: $(qemu-system-riscv64 --version | sed -n '1p')"
