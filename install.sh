#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SETUP_SCRIPT="${SCRIPT_DIR}/scripts/setup-ubuntu-20.04.sh"
readonly NODE_VERSION="24.19.0"

log() {
  printf '[qOS install] %s\n' "$*"
}

die() {
  printf '[qOS install] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install the verified user toolchain, build and provision the qOS QEMU firmware,
create a runtime profile, install user-local launchers, and open qOS Shell.

Options:
  --profile devnet|mainnet-external  Runtime profile (default: devnet)
  --home PATH                        Profile directory
  --destination PUBKEY               Pinned destination wallet
  --public-key PUBKEY                External signer public key (mainnet only)
  --signer-command PATH              Reviewed external signer adapter (mainnet)
  --skip-setup                       Use already-installed system/toolchain dependencies
  --skip-firmware                    Do not build the Devnet QEMU firmware
  --no-shell                         Finish without entering qOS Shell
  -h, --help                         Show this help

The default profile is disposable Devnet and never broadcasts automatically.
Mainnet setup creates no private key and requires an external signer.
EOF
}

profile="devnet"
qos_home=""
destination=""
public_key=""
signer_command=""
skip_setup=0
skip_firmware=0
open_shell=1
declare -A seen_options=()

while (($#)); do
  case "$1" in
    --profile)
      (($# >= 2)) || die "$1 requires a value."
      [[ "$2" != --* ]] || die "$1 requires a value."
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      profile="$2"
      shift 2
      ;;
    --home)
      (($# >= 2)) || die "$1 requires a value."
      [[ "$2" != --* ]] || die "$1 requires a value."
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      qos_home="$2"
      shift 2
      ;;
    --destination)
      (($# >= 2)) || die "$1 requires a value."
      [[ "$2" != --* ]] || die "$1 requires a value."
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      destination="$2"
      shift 2
      ;;
    --public-key)
      (($# >= 2)) || die "$1 requires a value."
      [[ "$2" != --* ]] || die "$1 requires a value."
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      public_key="$2"
      shift 2
      ;;
    --signer-command)
      (($# >= 2)) || die "$1 requires a value."
      [[ "$2" != --* ]] || die "$1 requires a value."
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      signer_command="$2"
      shift 2
      ;;
    --skip-setup)
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      skip_setup=1
      shift
      ;;
    --skip-firmware)
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      skip_firmware=1
      shift
      ;;
    --no-shell)
      [[ ! -v "seen_options[$1]" ]] || die "Duplicate option: $1"
      seen_options["$1"]=1
      open_shell=0
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

[[ "${profile}" == "devnet" || "${profile}" == "mainnet-external" ]] || die "--profile must be devnet or mainnet-external."
if [[ -z "${qos_home}" ]]; then
  qos_home="${HOME}/.local/share/qos/profiles/${profile}"
elif [[ "${qos_home}" != /* ]]; then
  qos_home="${PWD}/${qos_home}"
fi

if [[ "${profile}" == "devnet" ]]; then
  [[ -z "${public_key}" && -z "${signer_command}" ]] || die "External signer options are only valid with --profile mainnet-external."
else
  [[ -n "${public_key}" ]] || die "--public-key is required for mainnet-external."
  [[ -n "${destination}" ]] || die "--destination is required for mainnet-external."
  [[ "${signer_command}" == /* ]] || die "--signer-command must be an absolute path for mainnet-external."
fi

if (( ! skip_setup )); then
  "${SETUP_SCRIPT}" --install-toolchains
fi

toolchain_root="${QOS_TOOLCHAIN_ROOT:-${HOME}/.local/share/qos/toolchains}"
case "$(uname -m)" in
  x86_64) node_arch="x64" ;;
  aarch64|arm64) node_arch="arm64" ;;
  *) node_arch="" ;;
esac
node_home="${toolchain_root}/node-v${NODE_VERSION}-linux-${node_arch}"
if [[ -n "${node_arch}" && -x "${node_home}/bin/node" ]]; then
  export CARGO_HOME="${toolchain_root}/cargo"
  export RUSTUP_HOME="${toolchain_root}/rustup"
  export PATH="${node_home}/bin:${CARGO_HOME}/bin:${PATH}"
fi

for command_name in node cargo rustup make python3; do
  command -v "${command_name}" >/dev/null 2>&1 || die "${command_name} is unavailable; rerun without --skip-setup."
done
if (( ! skip_firmware )) && [[ "${profile}" == "devnet" ]]; then
  command -v qemu-system-riscv64 >/dev/null 2>&1 || die "qemu-system-riscv64 is unavailable; rerun without --skip-setup."
fi

node_binary="$(command -v node)"
node_environment=(env -i HOME="${HOME}" PATH="${PATH}" LANG=C.UTF-8)
[[ -z "${CARGO_HOME:-}" ]] || node_environment+=(CARGO_HOME="${CARGO_HOME}")
[[ -z "${RUSTUP_HOME:-}" ]] || node_environment+=(RUSTUP_HOME="${RUSTUP_HOME}")
run_node() {
  "${node_environment[@]}" "${node_binary}" "$@"
}
run_external_node() {
  "${node_environment[@]}" QOS_SIGNER_COMMAND="${signer_command}" "${node_binary}" "$@"
}

cd "${SCRIPT_DIR}"
log "Running the complete qOS security and regression suite."
"${node_environment[@]}" make check

json_field() {
  local field_name="$1"
  run_node -e '
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

if [[ -e "${qos_home}" ]]; then
  [[ -d "${qos_home}" ]] || die "The requested profile path exists but is not a directory: ${qos_home}"
  log "Using existing profile ${qos_home}."
  if [[ "${profile}" == "mainnet-external" ]]; then
    address_json="$(run_external_node bin/qos.js address --home "${qos_home}")"
  else
    address_json="$(run_node bin/qos.js address --home "${qos_home}")"
  fi
  existing_signer="$(printf '%s\n' "${address_json}" | json_field signer)"
  existing_cluster="$(printf '%s\n' "${address_json}" | json_field cluster)"
  expected_cluster="devnet"
  [[ "${profile}" != "mainnet-external" ]] || expected_cluster="mainnet-beta"
  [[ "${existing_cluster}" == "${expected_cluster}" ]] || die "Existing profile cluster does not match --profile ${profile}."
  if [[ -n "${public_key}" && "${existing_signer}" != "${public_key}" ]]; then
    die "Existing profile signer does not match --public-key."
  fi
  if [[ -n "${destination}" ]]; then
    existing_destination="$(run_node --input-type=module -e '
      import { loadPolicy } from "./src/policy.js";
      process.stdout.write(loadPolicy(process.argv[1]).allowedDestinations[0]);
    ' "${qos_home}/policy.json")"
    [[ "${existing_destination}" == "${destination}" ]] || die "Existing profile destination does not match --destination."
  fi
else
  if [[ "${profile}" == "devnet" ]]; then
    init_args=(init --home "${qos_home}" --cluster devnet)
    [[ -z "${destination}" ]] || init_args+=(--destination "${destination}")
    log "Creating a disposable Devnet signer, destination, and fail-closed policy."
    run_node bin/qos.js "${init_args[@]}"
  else
    log "Creating a public-only mainnet external-signer profile."
    run_node bin/qos-agent-external-setup.js \
      --home "${qos_home}" \
      --cluster mainnet-beta \
      --public-key "${public_key}" \
      --destination "${destination}" \
      --signer-command "${signer_command}" \
      --create
  fi
fi

profile_args=(create --home "${qos_home}" --profile "${profile}")
[[ "${profile}" != "mainnet-external" ]] || profile_args+=(--signer-command "${signer_command}")
profile_json="$(run_node bin/qos-profile.js "${profile_args[@]}")"
api_token_file="$(printf '%s\n' "${profile_json}" | json_field apiTokenFile)"

if (( ! skip_firmware )); then
  if [[ "${profile}" == "devnet" ]]; then
    log "Building and provisioning the private single-link QEMU firmware ELF."
    run_node bin/qos-firmware-demo.js build --home "${qos_home}"
  else
    log "QEMU firmware is not built for a public-only mainnet profile because QEMU requires a disposable host-readable demo seed."
  fi
fi

bin_directory="${QOS_INSTALL_BIN:-${HOME}/.local/bin}"
[[ "${bin_directory}" == /* ]] || die "QOS_INSTALL_BIN must be an absolute path."
[[ ! -L "${bin_directory}" ]] || die "QOS_INSTALL_BIN must not be a symbolic link."
install -d -m 0700 "${bin_directory}"
chmod 0700 "${bin_directory}"
[[ "$(stat -c '%u' "${bin_directory}")" == "$(id -u)" ]] || die "QOS_INSTALL_BIN must be owned by the current user."
path_prefix="$(dirname -- "${node_binary}"):$(dirname -- "$(command -v cargo)")"

write_launcher() {
  local name="$1"
  local target="$2"
  local destination_path="${bin_directory}/${name}"
  local temporary_path
  if [[ -e "${destination_path}" ]] && ! grep -Fqx '# qOS managed launcher' "${destination_path}" 2>/dev/null; then
    die "Refusing to replace an unmanaged command: ${destination_path}"
  fi
  temporary_path="$(mktemp "${bin_directory}/.${name}.tmp.XXXXXX")"
  {
    printf '%s\n' '#!/usr/bin/env bash' '# qOS managed launcher' 'set -Eeuo pipefail'
    printf 'export QOS_HOME=%q\n' "${qos_home}"
    printf 'export QOS_API_TOKEN_FILE=%q\n' "${api_token_file}"
    [[ -z "${signer_command}" ]] || printf 'export QOS_SIGNER_COMMAND=%q\n' "${signer_command}"
    [[ -z "${CARGO_HOME:-}" ]] || printf 'export CARGO_HOME=%q\n' "${CARGO_HOME}"
    [[ -z "${RUSTUP_HOME:-}" ]] || printf 'export RUSTUP_HOME=%q\n' "${RUSTUP_HOME}"
    printf 'export PATH=%q:"${PATH}"\n' "${path_prefix}"
    printf 'exec %q %q "$@"\n' "${node_binary}" "${SCRIPT_DIR}/${target}"
  } > "${temporary_path}"
  chmod 0700 "${temporary_path}"
  mv -- "${temporary_path}" "${destination_path}"
}

write_launcher qos bin/qos.js
write_launcher qos-shell bin/qos-shell.js
write_launcher qos-firmware bin/qos-firmware-demo.js
write_launcher qos-agent bin/qos-agent-demo.js
write_launcher qos-agent-security-audit bin/qos-agent-security-audit.js
write_launcher qos-agent-external-setup bin/qos-agent-external-setup.js
write_launcher qos-profile bin/qos-profile.js

log "Installed qOS launchers in ${bin_directory}."
log "Profile: ${qos_home}"
log "No transaction has been broadcast."
case ":${PATH}:" in
  *":${bin_directory}:"*) ;;
  *) log "For future terminals, add ${bin_directory} to PATH or invoke its launchers by absolute path." ;;
esac

if (( open_shell )); then
  exec "${bin_directory}/qos-shell" --home "${qos_home}"
fi

printf 'Run %q --home %q to enter qOS Shell.\n' "${bin_directory}/qos-shell" "${qos_home}"
