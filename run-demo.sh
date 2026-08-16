#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SETUP_SCRIPT="${SCRIPT_DIR}/scripts/setup-ubuntu-20.04.sh"

qos_home="${QOS_HOME:-.qos-ephemeral-devnet}"
lamports="${QOS_DEMO_LAMPORTS:-1000000}"
airdrop_lamports="${QOS_DEMO_AIRDROP_LAMPORTS:-200000000}"
live=0
broadcast=0
request_airdrop=0
build_only=0
setup_only=0
skip_setup=0

log() {
  printf '[qOS demo] %s\n' "$*"
}

warn() {
  printf '[qOS demo] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[qOS demo] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./run-demo.sh [options]

Install the Ubuntu prerequisites, initialize a disposable Solana Devnet
sandbox, build the bare-metal RISC-V firmware, and run it in QEMU.

Options:
  --home PATH              qOS sandbox directory (default: .qos-ephemeral-devnet)
  --lamports N             demo transfer amount (default: 1000000)
  --offline                deterministic run without Solana RPC (default)
  --live                   verify against live Devnet without broadcasting
  --airdrop                request Devnet SOL before a live run
  --airdrop-lamports N     airdrop amount (default: 200000000)
  --broadcast              verify and broadcast on Devnet
  --build-only             stop after checks and firmware build
  --setup-only             install prerequisites and stop
  --skip-setup             skip package/toolchain setup on this run
  -h, --help               show this help

The default offline run needs no faucet, funded signer, or Solana RPC.
This wrapper refuses to operate against a mainnet sandbox.
EOF
}

while (($#)); do
  case "$1" in
    --home)
      (($# >= 2)) || die "--home requires a path."
      qos_home="$2"
      shift 2
      ;;
    --lamports)
      (($# >= 2)) || die "--lamports requires an amount."
      lamports="$2"
      shift 2
      ;;
    --offline)
      live=0
      broadcast=0
      request_airdrop=0
      shift
      ;;
    --live)
      live=1
      broadcast=0
      shift
      ;;
    --airdrop)
      live=1
      request_airdrop=1
      shift
      ;;
    --airdrop-lamports)
      (($# >= 2)) || die "--airdrop-lamports requires an amount."
      airdrop_lamports="$2"
      shift 2
      ;;
    --broadcast)
      live=1
      broadcast=1
      shift
      ;;
    --build-only)
      build_only=1
      shift
      ;;
    --setup-only)
      setup_only=1
      shift
      ;;
    --skip-setup)
      skip_setup=1
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

[[ "${lamports}" =~ ^[1-9][0-9]*$ ]] || die "--lamports must be a positive integer."
[[ "${airdrop_lamports}" =~ ^[1-9][0-9]*$ ]] || die "--airdrop-lamports must be a positive integer."
[[ -n "${qos_home}" ]] || die "--home must not be empty."
(( ${#lamports} <= 18 )) || die "--lamports is too large."
(( ${#airdrop_lamports} <= 18 )) || die "--airdrop-lamports is too large."
(( 10#${airdrop_lamports} <= 1000000000 )) || die "--airdrop-lamports cannot exceed 1000000000."
(( setup_only && skip_setup )) && die "--setup-only cannot be combined with --skip-setup."
(( setup_only && build_only )) && die "--setup-only cannot be combined with --build-only."

if (( ! skip_setup )); then
  [[ -x "${SETUP_SCRIPT}" ]] || die "Setup script is missing or not executable: ${SETUP_SCRIPT}"
  "${SETUP_SCRIPT}"
fi

cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
export PATH="${cargo_home}/bin:${PATH}"

if (( setup_only )); then
  log "Setup-only run completed."
  exit 0
fi

cd "${SCRIPT_DIR}"

required_commands=(node cargo rustup make python3)
if (( ! build_only )); then
  required_commands+=(qemu-system-riscv64)
fi

for required_command in "${required_commands[@]}"; do
  command -v "${required_command}" >/dev/null 2>&1 || \
    die "${required_command} is unavailable. Re-run without --skip-setup."
done

log "Running project checks."
make check

if [[ ! -d "${qos_home}" ]]; then
  log "Initializing disposable Devnet state in ${qos_home}."
  node bin/qos.js init --home "${qos_home}"
else
  log "Using existing sandbox state in ${qos_home}."
fi

json_field() {
  local field_name="$1"
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input)[process.argv[1]];
      if (value === undefined || value === null) process.exit(2);
      process.stdout.write(String(value));
    });
  ' "${field_name}"
}

address_json="$(node bin/qos.js address --home "${qos_home}")"
signer="$(printf '%s\n' "${address_json}" | json_field signer)"
cluster="$(printf '%s\n' "${address_json}" | json_field cluster)"

if [[ "${cluster}" != "devnet" ]]; then
  die "run-demo.sh only supports Devnet; ${qos_home} is configured for ${cluster}."
fi

log "Devnet signer: ${signer}"
log "Building the provisioned RISC-V firmware with the locked Cargo dependency set."
node bin/qos-firmware-demo.js build --home "${qos_home}"

if (( build_only )); then
  log "Build-only run completed."
  exit 0
fi

if (( request_airdrop )); then
  log "Requesting ${airdrop_lamports} Devnet lamports for ${signer}."
  if ! node bin/qos.js airdrop --home "${qos_home}" --lamports "${airdrop_lamports}"; then
    warn "The public Devnet RPC refused the airdrop request. This is commonly rate limiting."
    warn "Fund ${signer} through https://faucet.solana.com/ and rerun with --live."
  fi
fi

demo_args=(run --home "${qos_home}" --lamports "${lamports}")
if (( broadcast )); then
  warn "Broadcast mode is enabled. This will spend disposable Devnet SOL."
  demo_args+=(--broadcast)
elif (( live )); then
  log "Running live Devnet verification without broadcasting."
else
  log "Running deterministic offline verification; no RPC or funds are required."
  demo_args+=(--offline)
fi

node bin/qos-firmware-demo.js "${demo_args[@]}"
log "Demo completed successfully."
