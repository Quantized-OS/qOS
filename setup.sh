#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SYSTEM_SETUP_SCRIPT="${SCRIPT_DIR}/scripts/setup-ubuntu-20.04.sh"
readonly NODE_VERSION="24.19.0"
readonly MANAGED_MARKER="# qOS managed launcher"
readonly LEGACY_INSTALLER="${SCRIPT_DIR}/install.sh"
readonly LEGACY_BACKUP_DIRECTORY="${SCRIPT_DIR}/.qos-setup-backup"
readonly -a MANAGED_LAUNCHERS=(
  qos
  qos-core
  qos-shell
  qos-firmware
  qos-agent
  qos-agent-security-audit
  qos-agent-external-setup
  qos-profile
)

print_banner() {
  cat <<'EOF'
  qqq     OOO    SSS
 q   q   O   O  S
 q   q   O   O   SSS
  qqqq    OOO       S
     q           SSS
       secure firmware shell
EOF
}

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
  print_banner
  cat <<'EOF'

Usage:
  ./setup.sh install [options]
  ./setup.sh uninstall [options]

Actions:
  install      Verify dependencies and source, provision a profile, install
               commands, and open qOS. Mainnet external custody is the default.
  uninstall    Remove only qOS-managed command launchers. Profiles, keys, and
               toolchains are preserved.

Run ./setup.sh install --help or ./setup.sh uninstall --help for action options.
EOF
}

install_usage() {
  print_banner
  cat <<'EOF'

Usage: ./setup.sh install [options]

Network and custody:
  -d, --devnet                 Use disposable Devnet software keys. Without this
                               option, setup uses mainnet external custody.
  -i, --insecure               Generate a locally accessible mainnet software key
                               after an explicit risk acknowledgement
  -y, --accept-insecure-risk   Non-interactive acknowledgement for --insecure
  -w, --wizard                 Run the guided questions even when input is piped
  -G, --signer-guide           Explain how to obtain and secure a signer adapter
  -P, --public-key PUBKEY      External signer public key (mainnet)
  -D, --destination PUBKEY     Pinned destination wallet
  -S, --signer-command PATH    Reviewed external signer adapter (mainnet)

Paths and behavior:
  -H, --home PATH              Profile directory
  -B, --bin PATH               User command directory (default: ~/.local/bin)
  -k, --skip-setup             Use already-installed dependencies
  -F, --skip-firmware          Do not build the Devnet QEMU firmware
  -n, --no-shell               Finish without entering qOS
  -h, --help                   Show this help

Normal mainnet setup never imports a private key and requires a reviewed
non-exportable signer adapter. --insecure deliberately generates an accessible
software key. Setup never funds an account or broadcasts a transaction.
EOF
}

print_insecure_notice() {
  cat <<'EOF'

INSECURE MAINNET KEY NOTICE
---------------------------

qOS will generate the live mainnet Ed25519 private key on this computer and
store it as an owner-only software key in the selected profile. The key is
usable for the same mainnet qOS operations as an external signer, but it is
accessible to programs running as this user. Malware, a compromised AI agent,
unsafe backups, or anyone who gains access to this account may copy the key and
steal every asset controlled by it.

Use this workaround only if you accept software-key custody. The safer default
is setup without --insecure, using a reviewed external signer.
EOF
}

print_signer_guide() {
  cat <<'EOF'

Reviewed signer adapter: simple setup guide
-------------------------------------------

A signer adapter is a small executable that lets qOS ask a separately secured
device or service to approve one exact transfer. The private key stays in that
device or service. qOS does not include a production adapter because the
correct integration depends on your HSM, secure element, KMS, MPC service, or
isolated signer.

Before using mainnet:

  1. Create an Ed25519 key inside your secure signer. Do not export its private
     key or seed. Record only its 32-byte Solana public key in base58 form.
  2. Have the adapter validate the qOS version-1 JSON request, recompute the
     intent commitment, enforce a protected copy of the policy commitment,
     rebuild the exact Solana message, and compare it byte-for-byte before it
     asks the secure signer to sign.
  3. Have an independent security reviewer check the adapter, its protected
     policy, access controls, replay handling, and failure behavior. A generic
     program that signs arbitrary bytes is not a reviewed qOS adapter.
  4. Install the reviewed executable in a root-controlled directory:

       sudo install -d -o root -g root -m 0755 /usr/local/libexec/qos
       sudo install -o root -g root -m 0755 ./YOUR_REVIEWED_ADAPTER \
         /usr/local/libexec/qos/qos-signer-adapter

  5. Obtain the allowlisted destination wallet address, then rerun:

       ./setup.sh install

The adapter reads one JSON object from standard input. It must accept only the
operation "authorize-and-sign-qos-intent" and return exactly:

  {"version":1,"publicKey":"...","signatureBase64":"..."}

It is started once per signing request, without a shell, from /, with a minimal
environment and a 10-second default deadline. Use absolute paths for any
adapter-owned configuration. Never use fixtures/external-signer.js for funds;
that file is a synthetic test fixture that reads an exportable software key.

The complete walkthrough is in docs/SIGNER_ADAPTER_SETUP.md and the custody
protocol is documented in docs/PRIVACY_ZK_CUSTODY.md.
EOF
}

uninstall_usage() {
  print_banner
  cat <<'EOF'

Usage: ./setup.sh uninstall [options]

Options:
  -B, --bin PATH               Command directory (default: ~/.local/bin)
  -h, --help                   Show this help

Uninstall removes only regular files bearing the qOS managed-launcher marker.
Profiles, policies, API tokens, keys, toolchains, and source files are retained
to prevent accidental loss of custody material.
EOF
}

mark_seen() {
  local canonical_name="$1"
  local display_name="$2"
  [[ -z "${seen_options[${canonical_name}]+present}" ]] || die "Duplicate option: ${display_name}"
  seen_options["${canonical_name}"]=1
}

require_option_value() {
  local option="$1"
  local value="${2-}"
  [[ -n "${value}" && "${value}" != -* ]] || die "${option} requires a value."
}

resolve_absolute_path() {
  local value="$1"
  if [[ "${value}" == /* ]]; then
    printf '%s\n' "${value}"
  else
    printf '%s/%s\n' "${PWD}" "${value}"
  fi
}

expand_home_path() {
  local value="$1"
  if [[ "${value}" == "~/"* ]]; then
    printf '%s/%s\n' "${HOME}" "${value#\~/}"
  else
    printf '%s\n' "${value}"
  fi
}

ask_yes_no() {
  local question="$1"
  local default_answer="$2"
  local hint="[y/N]"
  local answer
  [[ "${default_answer}" == "yes" ]] && hint="[Y/n]"
  while true; do
    printf '%s %s ' "${question}" "${hint}" >&2
    IFS= read -r answer || die "Setup input ended before the wizard was complete."
    if [[ -z "${answer}" ]]; then
      [[ "${default_answer}" == "yes" ]]
      return
    fi
    case "${answer}" in
      y|Y|yes|YES|Yes) return 0 ;;
      n|N|no|NO|No) return 1 ;;
      *) printf 'Please answer yes or no.\n' >&2 ;;
    esac
  done
}

prompt_required() {
  local question="$1"
  local answer
  while true; do
    printf '%s: ' "${question}" >&2
    IFS= read -r answer || die "Setup input ended before the wizard was complete."
    if [[ -n "${answer}" ]]; then
      prompt_result="${answer}"
      return
    fi
    printf 'A value is required.\n' >&2
  done
}

validate_signer_executable_shell() {
  local command_path="$1"
  local mode
  local mode_value
  local owner_uid

  signer_validation_error=""
  if [[ "${command_path}" != /* ]]; then
    signer_validation_error="Use the full absolute adapter path, beginning with /."
    return 1
  fi
  if [[ -L "${command_path}" ]]; then
    signer_validation_error="The adapter must be a real file, not a symbolic link."
    return 1
  fi
  if [[ ! -f "${command_path}" ]]; then
    signer_validation_error="No regular adapter file exists at ${command_path}."
    return 1
  fi
  if [[ "$(stat -c '%h' "${command_path}")" != "1" ]]; then
    signer_validation_error="The adapter must have exactly one hard link. Install a private copy with the commands in --signer-guide."
    return 1
  fi
  mode="$(stat -c '%a' "${command_path}")"
  mode_value=$((8#${mode}))
  if (( (mode_value & 0111) == 0 )) || [[ ! -x "${command_path}" ]]; then
    signer_validation_error="The adapter is not executable. Set a reviewed user-owned file to mode 0700, or a root-owned file to 0755."
    return 1
  fi
  if (( (mode_value & 0022) != 0 )); then
    signer_validation_error="The adapter is writable by a group or other users. Set a reviewed user-owned file to mode 0700, or a root-owned file to 0755."
    return 1
  fi
  if (( (mode_value & 06000) != 0 )); then
    signer_validation_error="The adapter must not have set-user-ID or set-group-ID permissions."
    return 1
  fi
  owner_uid="$(stat -c '%u' "${command_path}")"
  if (( EUID != 0 )) && [[ "${owner_uid}" != "0" && "${owner_uid}" != "$(id -u)" ]]; then
    signer_validation_error="The adapter must be owned by root or by the account running qOS."
    return 1
  fi
  return 0
}

retire_legacy_installer() {
  local size
  local owner_uid
  local backup_path
  local suffix=0

  [[ -e "${LEGACY_INSTALLER}" || -L "${LEGACY_INSTALLER}" ]] || return 0
  [[ -f "${LEGACY_INSTALLER}" && ! -L "${LEGACY_INSTALLER}" ]] \
    || die "A legacy install.sh exists but is not a regular file. Move it out of the qOS source directory and rerun setup."
  size="$(stat -c '%s' "${LEGACY_INSTALLER}")"
  [[ "${size}" -le 131072 ]] \
    || die "install.sh is too large to recognize safely. Move it out of the qOS source directory and rerun setup."
  owner_uid="$(stat -c '%u' "${LEGACY_INSTALLER}")"
  [[ "${owner_uid}" == "$(id -u)" ]] \
    || die "install.sh is not owned by the current user. Ask its owner to move it out of the qOS source directory."
  if ! grep -Fq '[qOS install]' "${LEGACY_INSTALLER}" \
    || ! grep -Fq 'Usage: ./install.sh [options]' "${LEGACY_INSTALLER}" \
    || ! grep -Fq 'scripts/setup-ubuntu-20.04.sh' "${LEGACY_INSTALLER}"; then
    die "An unrecognized install.sh is blocking the qOS safety checks. Preserve it outside this source directory, then rerun ./setup.sh install."
  fi

  if [[ -e "${LEGACY_BACKUP_DIRECTORY}" || -L "${LEGACY_BACKUP_DIRECTORY}" ]]; then
    [[ -d "${LEGACY_BACKUP_DIRECTORY}" && ! -L "${LEGACY_BACKUP_DIRECTORY}" ]] \
      || die "The legacy recovery path is not a private directory: ${LEGACY_BACKUP_DIRECTORY}"
    [[ "$(stat -c '%u' "${LEGACY_BACKUP_DIRECTORY}")" == "$(id -u)" ]] \
      || die "The legacy recovery directory is not owned by the current user."
  else
    install -d -m 0700 "${LEGACY_BACKUP_DIRECTORY}"
  fi
  chmod 0700 "${LEGACY_BACKUP_DIRECTORY}"
  backup_path="${LEGACY_BACKUP_DIRECTORY}/install.sh.retired"
  while [[ -e "${backup_path}" || -L "${backup_path}" ]]; do
    suffix=$((suffix + 1))
    backup_path="${LEGACY_BACKUP_DIRECTORY}/install.sh.retired.${suffix}"
  done
  mv -- "${LEGACY_INSTALLER}" "${backup_path}"
  chmod 0600 "${backup_path}"
  log "Retired the old install.sh to ${backup_path}."
  log "This prevents the retired installer from failing the security checks or selecting the old Devnet-default flow."
}

uninstall_launchers() {
  local bin_directory="$1"
  local name
  local path
  local size
  local removed=0

  [[ "${bin_directory}" == /* ]] || die "--bin must be an absolute path."
  [[ ! -L "${bin_directory}" ]] || die "The command directory must not be a symbolic link."
  if [[ ! -e "${bin_directory}" ]]; then
    log "No qOS command directory exists at ${bin_directory}."
    log "Profiles and toolchains were not removed."
    return
  fi
  [[ -d "${bin_directory}" ]] || die "The command path is not a directory: ${bin_directory}"
  [[ "$(stat -c '%u' "${bin_directory}")" == "$(id -u)" ]] || die "The command directory must be owned by the current user."

  for name in "${MANAGED_LAUNCHERS[@]}"; do
    path="${bin_directory}/${name}"
    [[ -e "${path}" || -L "${path}" ]] || continue
    if [[ -f "${path}" && ! -L "${path}" ]]; then
      size="$(stat -c '%s' "${path}")"
      if [[ "${size}" -le 16384 ]] && grep -Fqx "${MANAGED_MARKER}" "${path}"; then
        unlink -- "${path}"
        log "Removed ${path}."
        removed=$((removed + 1))
        continue
      fi
    fi
    warn "Preserved unmanaged or unsafe path: ${path}"
  done

  if (( removed == 0 )); then
    log "No managed qOS launchers were installed in ${bin_directory}."
  fi
  log "Profiles and toolchains were not removed."
}

if (($# == 0)); then
  usage
  exit 2
fi

case "$1" in
  -h|--help)
    usage
    exit 0
    ;;
  install|uninstall)
    action="$1"
    shift
    ;;
  *)
    usage >&2
    die "First argument must be install or uninstall."
    ;;
esac

devnet=0
insecure=0
accept_insecure_risk=0
qos_home=""
destination=""
public_key=""
signer_command=""
bin_directory="${QOS_INSTALL_BIN:-${HOME}/.local/bin}"
skip_setup=0
skip_firmware=0
open_shell=1
wizard=0
signer_guide=0
declare -A seen_options=()

while (($#)); do
  case "$1" in
    -d|--devnet)
      mark_seen devnet "$1"
      devnet=1
      shift
      ;;
    -i|--insecure)
      mark_seen insecure "$1"
      insecure=1
      shift
      ;;
    -y|--accept-insecure-risk)
      mark_seen accept_insecure_risk "$1"
      accept_insecure_risk=1
      shift
      ;;
    -w|--wizard)
      mark_seen wizard "$1"
      wizard=1
      shift
      ;;
    -G|--signer-guide)
      mark_seen signer_guide "$1"
      signer_guide=1
      shift
      ;;
    -H|--home)
      require_option_value "$1" "${2-}"
      mark_seen home "$1"
      qos_home="$2"
      shift 2
      ;;
    -D|--destination)
      require_option_value "$1" "${2-}"
      mark_seen destination "$1"
      destination="$2"
      shift 2
      ;;
    -P|--public-key)
      require_option_value "$1" "${2-}"
      mark_seen public_key "$1"
      public_key="$2"
      shift 2
      ;;
    -S|--signer-command)
      require_option_value "$1" "${2-}"
      mark_seen signer_command "$1"
      signer_command="$2"
      shift 2
      ;;
    -B|--bin)
      require_option_value "$1" "${2-}"
      mark_seen bin "$1"
      bin_directory="$2"
      shift 2
      ;;
    -k|--skip-setup)
      mark_seen skip_setup "$1"
      skip_setup=1
      shift
      ;;
    -F|--skip-firmware)
      mark_seen skip_firmware "$1"
      skip_firmware=1
      shift
      ;;
    -n|--no-shell)
      mark_seen no_shell "$1"
      open_shell=0
      shift
      ;;
    -h|--help)
      if [[ "${action}" == "install" ]]; then install_usage; else uninstall_usage; fi
      exit 0
      ;;
    *)
      die "Unknown option for ${action}: $1"
      ;;
  esac
done

if (( signer_guide )); then
  [[ "${action}" == "install" ]] || die "--signer-guide is available with the install action."
  print_banner
  print_signer_guide
  exit 0
fi

(( ! accept_insecure_risk || insecure )) || die "--accept-insecure-risk is valid only together with --insecure."
(( ! devnet || ! insecure )) || die "--insecure selects a mainnet software key and cannot be combined with --devnet."

if [[ "${bin_directory}" != /* ]]; then
  bin_directory="$(resolve_absolute_path "${bin_directory}")"
fi

if [[ "${action}" == "uninstall" ]]; then
  [[ "${devnet}" -eq 0 && "${insecure}" -eq 0 && "${accept_insecure_risk}" -eq 0 && -z "${qos_home}" && -z "${destination}" && -z "${public_key}" && -z "${signer_command}" \
    && "${skip_setup}" -eq 0 && "${skip_firmware}" -eq 0 && "${open_shell}" -eq 1 && "${wizard}" -eq 0 ]] \
    || die "uninstall accepts only --bin and --help."
  print_banner
  uninstall_launchers "${bin_directory}"
  exit 0
fi

profile="mainnet-external"
if (( devnet )); then
  profile="devnet"
elif (( insecure )); then
  profile="mainnet-insecure"
fi

if [[ -z "${qos_home}" ]]; then
  qos_home="${HOME}/.local/share/qos/profiles/${profile}"
elif [[ "${qos_home}" != /* ]]; then
  qos_home="$(resolve_absolute_path "${qos_home}")"
fi

interactive=0
if [[ -t 0 && -t 1 ]] || (( wizard )); then
  interactive=1
fi

retire_legacy_installer
print_banner
log "Selected profile: ${profile}."

if [[ "${profile}" == "devnet" ]]; then
  [[ -z "${public_key}" && -z "${signer_command}" ]] || die "--public-key and --signer-command are mainnet-only options."
  if (( interactive )); then
    cat <<EOF

Guided setup: disposable Devnet
--------------------------------

Devnet is the practice network. qOS will create disposable software keys,
a strict transfer policy, a private API token, and the QEMU firmware demo.
It will not request funds or broadcast a transaction.

Profile files:  ${qos_home}
Commands:       ${bin_directory}
EOF
    if ! ask_yes_no "Continue with this Devnet setup?" "yes"; then
      log "Setup cancelled before making system or profile changes."
      exit 0
    fi
  fi
elif [[ "${profile}" == "mainnet-insecure" ]]; then
  (( ! skip_firmware )) || die "--skip-firmware is only valid together with --devnet."
  [[ -z "${public_key}" && -z "${signer_command}" ]] \
    || die "--public-key and --signer-command cannot be combined with --insecure because qOS generates the software key locally."
  print_insecure_notice
  if [[ ! -e "${qos_home}" && -z "${destination}" ]]; then
    if (( interactive )); then
      printf '\nThis is the only destination wallet allowed by the generated mainnet profile.\n' >&2
      prompt_required "Allowlisted destination public key"
      destination="${prompt_result}"
    else
      die "--destination is required when creating a non-interactive --insecure mainnet profile."
    fi
  fi
  cat <<EOF

Guided setup: mainnet with a locally generated key
---------------------------------------------------

Network:        Solana mainnet-beta
Key custody:    locally generated software key (accessible)
Destination:    ${destination:-stored profile destination}
Profile files:  ${qos_home}
Commands:       ${bin_directory}

The profile will have the same qOS mainnet transfer and agent capabilities as
the external-signer setup. Only the key-custody boundary is different. Setup
will not fund the key or broadcast a transaction.
EOF
  if (( ! accept_insecure_risk )); then
    (( interactive )) \
      || die "Read the insecure mainnet key notice, then rerun with --accept-insecure-risk for unattended setup."
    if ! ask_yes_no "I accept that the generated mainnet private key is accessible and can be stolen. Continue?" "no"; then
      log "Setup cancelled before creating a profile, key, or launcher."
      exit 0
    fi
  else
    log "Accepted the accessible mainnet software-key notice from --accept-insecure-risk."
  fi
else
  (( ! skip_firmware )) || die "--skip-firmware is only valid together with --devnet."
  if [[ ! -e "${qos_home}" ]]; then
    if (( interactive )); then
      cat <<EOF

Guided setup: mainnet with an external signer
------------------------------------------------

Mainnet is the live Solana network. qOS will never ask for a private key,
seed phrase, recovery phrase, or HSM secret. You will enter only:

  - the public address of the key held by your secure signer;
  - the one destination wallet this profile may use; and
  - the absolute path to the reviewed adapter executable.

Profile files:  ${qos_home}
Commands:       ${bin_directory}
EOF
      if ! ask_yes_no "Do you already have the external Ed25519 key and reviewed qOS adapter?" "no"; then
        print_signer_guide
        warn "Mainnet setup is incomplete. No dependencies, profile, key, or launcher were created."
        exit 2
      fi
      if [[ -z "${public_key}" ]]; then
        printf '\nThis is the public Solana address from the secure signer. Never enter a private key.\n' >&2
        prompt_required "External signer public key"
        public_key="${prompt_result}"
      fi
      if [[ -z "${destination}" ]]; then
        printf '\nThis is the only destination wallet allowed by the new profile.\n' >&2
        prompt_required "Allowlisted destination public key"
        destination="${prompt_result}"
      fi
      while true; do
        if [[ -z "${signer_command}" ]]; then
          printf '\nEnter the installed adapter path, for example /usr/local/libexec/qos/qos-signer-adapter.\n' >&2
          prompt_required "Reviewed signer adapter"
          signer_command="$(expand_home_path "${prompt_result}")"
        fi
        if validate_signer_executable_shell "${signer_command}"; then
          break
        fi
        printf 'Adapter check failed: %s\n' "${signer_validation_error}" >&2
        signer_command=""
      done
      if (( EUID != 0 )) && [[ "$(stat -c '%u' "${signer_command}")" == "$(id -u)" ]]; then
        warn "The adapter is owned by the qOS account. A root-owned adapter in /usr/local/libexec/qos provides a stronger replacement boundary."
      fi
      cat <<EOF

Ready to install
----------------
Network:        Solana mainnet-beta
Signer address: ${public_key}
Destination:    ${destination}
Adapter:        ${signer_command}
Profile files:  ${qos_home}
Commands:       ${bin_directory}

Setup will install verified dependencies, run all security tests, create a
public-only profile, and install the qOS shell. It will not fund or broadcast.
EOF
      if ! ask_yes_no "Install qOS with these settings?" "no"; then
        log "Setup cancelled before making system or profile changes."
        exit 0
      fi
    else
      [[ -n "${public_key}" && -n "${destination}" && -n "${signer_command}" ]] \
        || die "Mainnet is the default. Supply --public-key, --destination, and --signer-command, or pass --devnet for disposable development setup."
    fi
  elif (( interactive )); then
    cat <<EOF

Guided setup: reuse existing mainnet profile
------------------------------------------------

qOS found an existing public-only profile at:
  ${qos_home}

It will verify the stored signer identity, policy, adapter, and API token. It
will not replace custody files or broadcast a transaction.
EOF
    if ! ask_yes_no "Verify this profile and reinstall the qOS commands?" "yes"; then
      log "Setup cancelled before making system or profile changes."
      exit 0
    fi
  fi
  if [[ -n "${signer_command}" ]]; then
    signer_command="$(expand_home_path "${signer_command}")"
    [[ "${signer_command}" == /* ]] || die "--signer-command must be an absolute path."
    validate_signer_executable_shell "${signer_command}" || die "${signer_validation_error}"
  fi
fi

if (( ! skip_setup )); then
  "${SYSTEM_SETUP_SCRIPT}" --install-toolchains
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

if [[ "${profile}" == "mainnet-external" && -e "${qos_home}" \
  && ( -z "${public_key}" || -z "${destination}" || -z "${signer_command}" ) ]]; then
  runtime_json="$(run_node bin/qos-profile.js show --home "${qos_home}")" \
    || die "Existing mainnet profile cannot be reused; provide all mainnet options."
  if [[ -z "${signer_command}" ]]; then
    signer_command="$(printf '%s\n' "${runtime_json}" | json_field signerCommand)"
  fi
  address_json="$(run_external_node bin/qos.js address --home "${qos_home}")"
  if [[ -z "${public_key}" ]]; then
    public_key="$(printf '%s\n' "${address_json}" | json_field signer)"
  fi
  if [[ -z "${destination}" ]]; then
    destination="$(run_node --input-type=module -e '
      import { loadPolicy } from "./src/policy.js";
      process.stdout.write(loadPolicy(process.argv[1]).allowedDestinations[0]);
    ' "${qos_home}/policy.json")"
  fi
fi

if [[ "${profile}" == "mainnet-insecure" && -e "${qos_home}" && -z "${destination}" ]]; then
  runtime_json="$(run_node bin/qos-profile.js show --home "${qos_home}")" \
    || die "Existing insecure mainnet profile cannot be reused; select a valid --insecure profile home."
  [[ "$(printf '%s\n' "${runtime_json}" | json_field profile)" == "mainnet-insecure" ]] \
    || die "Existing profile was not created with --insecure."
  destination="$(run_node --input-type=module -e '
    import { loadPolicy } from "./src/policy.js";
    process.stdout.write(loadPolicy(process.argv[1]).allowedDestinations[0]);
  ' "${qos_home}/policy.json")"
fi

if [[ "${profile}" == "mainnet-external" ]]; then
  [[ -n "${public_key}" ]] || die "--public-key is required for mainnet setup."
  [[ -n "${destination}" ]] || die "--destination is required for mainnet setup."
  [[ "${signer_command}" == /* ]] || die "--signer-command must be an absolute path for mainnet setup."
fi

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
  [[ "${profile}" == "devnet" ]] || expected_cluster="mainnet-beta"
  [[ "${existing_cluster}" == "${expected_cluster}" ]] || die "Existing profile cluster does not match the selected network."
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
  elif [[ "${profile}" == "mainnet-insecure" ]]; then
    log "Generating the acknowledged locally accessible mainnet Ed25519 software key."
    run_node bin/qos.js init \
      --home "${qos_home}" \
      --cluster mainnet-beta \
      --destination "${destination}"
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
[[ "${profile}" != "mainnet-insecure" ]] || profile_args+=(--accept-insecure-risk)
profile_json="$(run_node bin/qos-profile.js "${profile_args[@]}")"
api_token_file="$(printf '%s\n' "${profile_json}" | json_field apiTokenFile)"

if (( ! skip_firmware )); then
  if [[ "${profile}" == "devnet" ]]; then
    log "Building and provisioning the private single-link QEMU firmware ELF."
    run_node bin/qos-firmware-demo.js build --home "${qos_home}"
  else
    log "QEMU firmware is not built for mainnet because its demo seed would be host-readable."
  fi
fi

[[ "${bin_directory}" == /* ]] || die "--bin must be an absolute path."
[[ ! -L "${bin_directory}" ]] || die "The command directory must not be a symbolic link."
install -d -m 0700 "${bin_directory}"
chmod 0700 "${bin_directory}"
[[ "$(stat -c '%u' "${bin_directory}")" == "$(id -u)" ]] || die "The command directory must be owned by the current user."
path_prefix="$(dirname -- "${node_binary}"):$(dirname -- "$(command -v cargo)")"

validate_launcher_target() {
  local name="$1"
  local destination_path="${bin_directory}/${name}"
  if [[ -e "${destination_path}" || -L "${destination_path}" ]]; then
    [[ -f "${destination_path}" && ! -L "${destination_path}" ]] \
      || die "Refusing to replace a non-regular command: ${destination_path}"
    [[ "$(stat -c '%u' "${destination_path}")" == "$(id -u)" ]] \
      || die "Refusing to replace a command not owned by the current user: ${destination_path}"
    [[ "$(stat -c '%s' "${destination_path}")" -le 16384 ]] \
      || die "Refusing to inspect an oversized command: ${destination_path}"
    grep -Fqx "${MANAGED_MARKER}" "${destination_path}" \
      || die "Refusing to replace an unmanaged command: ${destination_path}"
  fi
}

for launcher_name in "${MANAGED_LAUNCHERS[@]}"; do
  validate_launcher_target "${launcher_name}"
done

write_launcher() {
  local name="$1"
  local target="$2"
  local destination_path="${bin_directory}/${name}"
  local temporary_path
  validate_launcher_target "${name}"
  temporary_path="$(mktemp "${bin_directory}/.${name}.tmp.XXXXXX")"
  {
    printf '%s\n' '#!/usr/bin/env bash' "${MANAGED_MARKER}" 'set -Eeuo pipefail'
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

write_launcher qos bin/qos-shell.js
write_launcher qos-core bin/qos.js
write_launcher qos-shell bin/qos-shell.js
write_launcher qos-firmware bin/qos-firmware-demo.js
write_launcher qos-agent bin/qos-agent-demo.js
write_launcher qos-agent-security-audit bin/qos-agent-security-audit.js
write_launcher qos-agent-external-setup bin/qos-agent-external-setup.js
write_launcher qos-profile bin/qos-profile.js

log "Installed qOS commands in ${bin_directory}."
log "Profile: ${qos_home}"
log "No transaction has been broadcast."
if [[ "${profile}" == "devnet" ]]; then
  cat <<'EOF'

Setup complete. qOS will open on disposable Devnet.

Start here:
  capa              show exactly what this profile can do
  stat              show its address and key-custody status
  fw off s 1000000  rehearse a transfer entirely offline
  h                 show every command
EOF
elif [[ "${profile}" == "mainnet-insecure" ]]; then
  cat <<'EOF'

Setup complete. qOS will open on mainnet with a locally generated software key.
The key is accessible to programs running as this user. All standard qOS
mainnet policy, simulation, agent, signing, submission, and confirmation paths
are enabled.

Start here:
  capa              show mainnet capabilities and accessible key custody
  stat              inspect signer and privacy status
  tok addr          show the pinned qOS Token-2022 account
  tok prep 1000000  prepare one token without signing or broadcasting
  h                 show every command
EOF
else
  cat <<'EOF'

Setup complete. qOS will open with public-only mainnet custody.
The private key was not imported and QEMU signing is disabled for mainnet.

Start here:
  capa              confirm mainnet-external custody
  stat              inspect signer and privacy status
  tok addr          show the pinned qOS Token-2022 account
  tok prep 1000000  prepare one token without signing or broadcasting
  h                 show every command
EOF
fi
case ":${PATH}:" in
  *":${bin_directory}:"*) ;;
  *) log "For future terminals, add ${bin_directory} to PATH or invoke qos by absolute path." ;;
esac

if (( open_shell )); then
  exec "${bin_directory}/qos" --home "${qos_home}"
fi

printf 'Run %q to enter qOS.\n' "${bin_directory}/qos"
