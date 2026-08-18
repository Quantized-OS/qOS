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
)
readonly -a LEGACY_MANAGED_LAUNCHERS=(
  qos-core
  qos-shell
  qos-firmware
  qos-agent
  qos-agent-demo
  qos-agent-security-audit
  qos-agent-external-setup
  qos-model
  qos-profile
  qos-policy
  qos-wallet
)
readonly -a ALL_MANAGED_LAUNCHERS=("${MANAGED_LAUNCHERS[@]}" "${LEGACY_MANAGED_LAUNCHERS[@]}")

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
  install      Verify dependencies and source, provision a profile, install the
               single qos command, and open it. Mainnet setup asks whether to use an
               existing external key or generate an accessible software key.
  uninstall    Stop qOS services and permanently remove all qOS-managed data,
               keys, credentials, toolchains, launchers, logs, and build output.

Run ./setup.sh install --help or ./setup.sh uninstall --help for action options.
EOF
}

install_usage() {
  print_banner
  cat <<'EOF'

Usage: ./setup.sh install [options]

Network and custody:
  -d, --devnet                 Use disposable Devnet software keys. Without this
                               option, setup opens the mainnet custody chooser.
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
  -v, --verbose                Show the complete security-suite output
      --offline                Skip cluster readiness checks and Devnet funding
      --no-fund                Verify Devnet but do not request its default airdrop
      --airdrop-lamports N     Devnet funding amount (default: 200000000)
  -n, --no-shell               Finish without entering qOS
  -h, --help                   Show this help

Optional first agent:
      --agent-id ID            Onboard one agent during setup
      --agent-name NAME        Human-readable agent name
      --agent-approval MODE    ask or auto (default: ask)
      --agent-asset ASSET      sol on Devnet; qos-token on mainnet
      --agent-max-amount N     Maximum base units per request
      --agent-destination KEY  Policy-allowlisted destination
      --agent-strategy-id ID   Policy-allowlisted strategy ID
      --accept-auto            Acknowledge unattended automatic execution

With no custody option, the interactive mainnet wizard asks whether to use an
existing key through a reviewed non-exportable signer adapter or generate a
local key. The generated-key choice continues exactly as --insecure and requires
the same explicit warning acceptance. qOS never imports an existing private key.
Devnet setup requests a confirmed faucet airdrop unless --no-fund or --offline
is selected. Mainnet setup never funds or broadcasts. Interactive setup also
offers model onboarding: choose any built-in commercial BYOK provider, or press
Enter for local Ollama-compatible defaults. Only the `qos` command is installed.
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
  -y, --yes                    Confirm the full purge non-interactively
  -h, --help                   Show this help

WARNING: uninstall permanently removes qOS-managed profiles, private keys,
policies, agent credentials and skills, runtime tokens, managed services, logs,
downloaded browser releases, user-local toolchains, and build artifacts. An
unmanaged Git source checkout and unmanaged command files are preserved.
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

prompt_default() {
  local question="$1"
  local default_value="$2"
  local answer
  printf '%s [%s]: ' "${question}" "${default_value}" >&2
  IFS= read -r answer || die "Setup input ended before the wizard was complete."
  prompt_result="${answer:-${default_value}}"
}

choose_mainnet_custody() {
  local answer
  cat <<'EOF'

Mainnet key setup
-----------------

How should qOS get the signing identity for your source wallet?

  1) Use a key I already control (recommended)
     The private key stays in your external signer. qOS asks only for its
     public key and the path to a reviewed signer adapter.

  2) Generate a key for me (--insecure)
     qOS creates a mainnet software key on this computer. Programs running as
     your user can access and copy it. A separate warning and acceptance step
     is required before the key is created.

qOS never asks you to paste an existing private key or recovery phrase.
Type guide for the external-signer setup instructions.
EOF
  while true; do
    printf 'Choose 1 or 2 [1]: ' >&2
    IFS= read -r answer || die "Setup input ended before the wizard was complete."
    case "${answer:-1}" in
      1|existing|own)
        custody_selected_by_wizard="external"
        log "Using your existing key through a reviewed external signer."
        return
        ;;
      2|generate|generated)
        custody_selected_by_wizard="generated"
        insecure=1
        log "Generated-key custody selected; continuing with the --insecure mainnet setup."
        return
        ;;
      g|G|guide|GUIDE|Guide)
        print_signer_guide
        warn "Mainnet setup is incomplete. No dependencies, profile, key, or launcher were created."
        exit 2
        ;;
      *) printf 'Enter 1 for your existing external key, 2 to generate a key, or guide.\n' >&2 ;;
    esac
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
    return
  fi
  [[ -d "${bin_directory}" ]] || die "The command path is not a directory: ${bin_directory}"
  [[ "$(stat -c '%u' "${bin_directory}")" == "$(id -u)" ]] || die "The command directory must be owned by the current user."

  for name in "${ALL_MANAGED_LAUNCHERS[@]}"; do
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
}

retire_legacy_launchers() {
  local name
  local path
  local size
  local removed=0

  for name in "${LEGACY_MANAGED_LAUNCHERS[@]}"; do
    path="${bin_directory}/${name}"
    [[ -e "${path}" || -L "${path}" ]] || continue
    if [[ -f "${path}" && ! -L "${path}" ]]; then
      size="$(stat -c '%s' "${path}")"
      if [[ "${size}" -le 16384 ]] && grep -Fqx "${MANAGED_MARKER}" "${path}"; then
        unlink -- "${path}"
        removed=$((removed + 1))
        continue
      fi
    fi
    warn "Preserved unmanaged legacy command: ${path}"
  done
  if (( removed > 0 )); then
    log "Retired ${removed} legacy qOS command launcher(s); use qos for every operation."
  fi
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
verbose=0
open_shell=1
wizard=0
signer_guide=0
offline=0
no_fund=0
airdrop_lamports="200000000"
agent_id=""
agent_name=""
agent_approval="ask"
agent_asset=""
agent_max_amount=""
agent_destination=""
agent_strategy_id=""
accept_auto=0
uninstall_yes=0
custody_selected_by_wizard=""
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
    -y)
      if [[ "${action}" == "uninstall" ]]; then
        mark_seen uninstall_yes "$1"
        uninstall_yes=1
      else
        mark_seen accept_insecure_risk "$1"
        accept_insecure_risk=1
      fi
      shift
      ;;
    --yes)
      [[ "${action}" == "uninstall" ]] || die "--yes is valid only with uninstall; use --accept-insecure-risk for an insecure mainnet install."
      mark_seen uninstall_yes "$1"
      uninstall_yes=1
      shift
      ;;
    --accept-insecure-risk)
      [[ "${action}" == "install" ]] || die "--accept-insecure-risk is valid only with install."
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
    -v|--verbose)
      mark_seen verbose "$1"
      verbose=1
      shift
      ;;
    --offline)
      mark_seen offline "$1"
      offline=1
      shift
      ;;
    --no-fund)
      mark_seen no_fund "$1"
      no_fund=1
      shift
      ;;
    --airdrop-lamports)
      require_option_value "$1" "${2-}"
      mark_seen airdrop_lamports "$1"
      airdrop_lamports="$2"
      shift 2
      ;;
    --agent-id)
      require_option_value "$1" "${2-}"
      mark_seen agent_id "$1"
      agent_id="$2"
      shift 2
      ;;
    --agent-name)
      require_option_value "$1" "${2-}"
      mark_seen agent_name "$1"
      agent_name="$2"
      shift 2
      ;;
    --agent-approval)
      require_option_value "$1" "${2-}"
      mark_seen agent_approval "$1"
      agent_approval="$2"
      shift 2
      ;;
    --agent-asset)
      require_option_value "$1" "${2-}"
      mark_seen agent_asset "$1"
      agent_asset="$2"
      shift 2
      ;;
    --agent-max-amount)
      require_option_value "$1" "${2-}"
      mark_seen agent_max_amount "$1"
      agent_max_amount="$2"
      shift 2
      ;;
    --agent-destination)
      require_option_value "$1" "${2-}"
      mark_seen agent_destination "$1"
      agent_destination="$2"
      shift 2
      ;;
    --agent-strategy-id)
      require_option_value "$1" "${2-}"
      mark_seen agent_strategy_id "$1"
      agent_strategy_id="$2"
      shift 2
      ;;
    --accept-auto)
      mark_seen accept_auto "$1"
      accept_auto=1
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
    && "${skip_setup}" -eq 0 && "${skip_firmware}" -eq 0 && "${verbose}" -eq 0 && "${open_shell}" -eq 1 && "${wizard}" -eq 0 \
    && "${offline}" -eq 0 && "${no_fund}" -eq 0 && "${airdrop_lamports}" == "200000000" \
    && -z "${agent_id}" && -z "${agent_name}" && "${agent_approval}" == "ask" && -z "${agent_asset}" \
    && -z "${agent_max_amount}" && -z "${agent_destination}" && -z "${agent_strategy_id}" && "${accept_auto}" -eq 0 ]] \
    || die "uninstall accepts only --bin, --yes, and --help."
  print_banner
  cat <<'EOF'

FULL qOS PURGE
--------------
This permanently deletes every registered qOS profile and software key, all
agent and API credentials, policies, skills, managed listener state and logs,
downloaded browser releases, qOS user toolchains, launchers, and build output.
This cannot be undone. Shared Ubuntu packages and an unmanaged Git checkout are
not removed.
EOF
  if (( ! uninstall_yes )); then
    [[ -t 0 && -t 1 ]] || die "Unattended uninstall requires --yes."
    printf 'Type DELETE to permanently remove all qOS-managed artifacts: ' >&2
    IFS= read -r purge_confirmation || die "Uninstall input ended before confirmation."
    [[ "${purge_confirmation}" == "DELETE" ]] || die "Full qOS purge was not confirmed."
  fi
  data_root="${XDG_DATA_HOME:-${HOME}/.local/share}"
  [[ "${data_root}" == /* ]] || die "XDG_DATA_HOME must be an absolute path."
  purge_node="$(command -v node || true)"
  if [[ -z "${purge_node}" ]]; then
    case "$(uname -m)" in
      x86_64) purge_node="${data_root}/qos/toolchains/node-v${NODE_VERSION}-linux-x64/bin/node" ;;
      aarch64|arm64) purge_node="${data_root}/qos/toolchains/node-v${NODE_VERSION}-linux-arm64/bin/node" ;;
      *) purge_node="" ;;
    esac
  fi
  [[ -n "${purge_node}" && -x "${purge_node}" ]] || die "Node.js is required to perform the ownership-checked full purge."
  "${purge_node}" "${SCRIPT_DIR}/scripts/qos-install-state.js" purge \
    --data-root "${data_root}" \
    --project-root "${SCRIPT_DIR}" \
    --bin "${bin_directory}" >/dev/null
  uninstall_launchers "${bin_directory}"
  log "Full qOS purge complete. Managed profiles, keys, credentials, services, toolchains, logs, and build artifacts were removed."
  log "Unmanaged launchers and an unmanaged Git source checkout were preserved."
  exit 0
fi

[[ "${airdrop_lamports}" =~ ^[1-9][0-9]*$ ]] || die "--airdrop-lamports must be a positive canonical integer."
(( ! offline || ! no_fund )) || die "--offline and --no-fund are redundant; choose one."
if [[ "${airdrop_lamports}" != "200000000" && ( "${offline}" -eq 1 || "${no_fund}" -eq 1 ) ]]; then
  die "--airdrop-lamports cannot be combined with --offline or --no-fund."
fi
[[ "${agent_approval}" == "ask" || "${agent_approval}" == "auto" ]] || die "--agent-approval must be ask or auto."
[[ "${accept_auto}" -eq 0 || "${agent_approval}" == "auto" ]] || die "--accept-auto requires --agent-approval auto."
if [[ -n "${agent_name}" || -n "${agent_asset}" || -n "${agent_max_amount}" || -n "${agent_destination}" || -n "${agent_strategy_id}" || "${agent_approval}" != "ask" || "${accept_auto}" -eq 1 ]]; then
  [[ -n "${agent_id}" ]] || die "--agent-id is required when any first-agent option is supplied."
fi
if [[ -n "${agent_id}" ]]; then
  [[ "${agent_id}" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "--agent-id must start with a lowercase letter and contain at most 32 lowercase letters, digits, or hyphens."
fi

interactive=0
if [[ -t 0 && -t 1 ]] || (( wizard )); then
  interactive=1
fi
banner_printed=0
if (( interactive && ! devnet && ! insecure )) && [[ -z "${public_key}" && -z "${signer_command}" ]]; then
  print_banner
  banner_printed=1
  choose_mainnet_custody
fi

profile="mainnet-external"
if (( devnet )); then
  profile="devnet"
elif (( insecure )); then
  profile="mainnet-insecure"
fi
if [[ "${profile}" == "devnet" ]]; then
  profile_agent_asset="sol"
  profile_agent_action="native SOL transfer"
else
  profile_agent_asset="qos-token"
  profile_agent_action="qOS Token-2022 transfer"
fi
if [[ -n "${agent_asset}" && "${agent_asset}" != "${profile_agent_asset}" ]]; then
  die "--agent-asset ${agent_asset} is disabled for ${profile}; the enabled setup asset is ${profile_agent_asset} (${profile_agent_action})."
fi

if [[ -z "${qos_home}" ]]; then
  qos_home="${HOME}/.local/share/qos/profiles/${profile}"
elif [[ "${qos_home}" != /* ]]; then
  qos_home="$(resolve_absolute_path "${qos_home}")"
fi

if [[ -n "${agent_id}" && "${interactive}" -eq 0 ]]; then
  [[ -n "${agent_max_amount}" ]] || die "Unattended first-agent setup requires --agent-max-amount."
fi
if [[ "${profile}" != "devnet" ]]; then
  (( ! no_fund )) || die "--no-fund is valid only together with --devnet."
  [[ "${airdrop_lamports}" == "200000000" ]] || die "--airdrop-lamports is valid only together with --devnet."
fi

retire_legacy_installer
(( banner_printed )) || print_banner
log "Selected profile: ${profile}."

if [[ "${profile}" == "devnet" ]]; then
  [[ -z "${public_key}" && -z "${signer_command}" ]] || die "--public-key and --signer-command are mainnet-only options."
  if (( interactive )); then
    cat <<EOF

Guided setup: disposable Devnet
--------------------------------

Devnet is the practice network. qOS will create disposable software keys,
a strict transfer policy, a private API token, and the QEMU firmware demo.
Unless --no-fund or --offline was selected, it will request and confirm a
Devnet faucet airdrop for the new source wallet. It will not spend those funds.

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
  if (( verbose )); then
    "${SYSTEM_SETUP_SCRIPT}" --install-toolchains
  else
    log "Installing or verifying pinned dependencies; this can take a few minutes."
    dependency_log="$(mktemp "${TMPDIR:-/tmp}/qos-dependencies.XXXXXX")"
    if ! "${SYSTEM_SETUP_SCRIPT}" --install-toolchains >"${dependency_log}" 2>&1; then
      cat "${dependency_log}" >&2
      unlink -- "${dependency_log}"
      die "Dependency setup failed."
    fi
    unlink -- "${dependency_log}"
    log "Pinned dependencies are ready."
  fi
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
[[ -z "${QOS_AGENT_AUTOSERVE:-}" ]] || node_environment+=(QOS_AGENT_AUTOSERVE="${QOS_AGENT_AUTOSERVE}")
[[ -z "${QOS_AGENT_PORT:-}" ]] || node_environment+=(QOS_AGENT_PORT="${QOS_AGENT_PORT}")
run_node() {
  "${node_environment[@]}" "${node_binary}" "$@"
}
run_external_node() {
  "${node_environment[@]}" QOS_SIGNER_COMMAND="${signer_command}" "${node_binary}" "$@"
}

cd "${SCRIPT_DIR}"
log "Running the qOS security and regression suite. Use --verbose to show every check."
if (( verbose )); then
  "${node_environment[@]}" make check
else
  check_log="$(mktemp "${TMPDIR:-/tmp}/qos-check.XXXXXX")"
  if ! "${node_environment[@]}" make check >"${check_log}" 2>&1; then
    cat "${check_log}" >&2
    unlink -- "${check_log}"
    die "The qOS security and regression suite failed; setup stopped before installing commands."
  fi
  check_count="$(sed -n 's/^.*tests \([0-9][0-9]*\)$/\1/p' "${check_log}" | tail -n 1)"
  unlink -- "${check_log}"
  if [[ -n "${check_count}" ]]; then
    log "Security suite passed (${check_count} tests)."
  else
    log "Security suite passed."
  fi
fi

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
    created_profile="$(run_node bin/qos.js "${init_args[@]}")"
  elif [[ "${profile}" == "mainnet-insecure" ]]; then
    log "Generating the acknowledged locally accessible mainnet Ed25519 software key."
    created_profile="$(run_node bin/qos.js init \
      --home "${qos_home}" \
      --cluster mainnet-beta \
      --destination "${destination}")"
  else
    log "Creating a public-only mainnet external-signer profile."
    created_profile="$(run_node bin/qos-agent-external-setup.js \
      --home "${qos_home}" \
      --cluster mainnet-beta \
      --public-key "${public_key}" \
      --destination "${destination}" \
      --signer-command "${signer_command}" \
      --create)"
  fi
  cat <<EOF

Profile created
---------------
Network:        $(printf '%s\n' "${created_profile}" | json_field cluster)
Source wallet:  $(printf '%s\n' "${created_profile}" | json_field signer)
Destination:    $(printf '%s\n' "${created_profile}" | json_field destination)
Key custody:    $(printf '%s\n' "${created_profile}" | json_field keyCustody)
Profile files:  ${qos_home}
EOF
fi

profile_args=(create --home "${qos_home}" --profile "${profile}")
[[ "${profile}" != "mainnet-external" ]] || profile_args+=(--signer-command "${signer_command}")
[[ "${profile}" != "mainnet-insecure" ]] || profile_args+=(--accept-insecure-risk)
profile_json="$(run_node bin/qos-profile.js "${profile_args[@]}")"
api_token_file="$(printf '%s\n' "${profile_json}" | json_field apiTokenFile)"
data_root="${XDG_DATA_HOME:-${HOME}/.local/share}"
[[ "${data_root}" == /* ]] || die "XDG_DATA_HOME must be an absolute path."
run_node scripts/qos-install-state.js register \
  --data-root "${data_root}" \
  --home "${qos_home}" \
  --bin "${bin_directory}" \
  --toolchain-root "${toolchain_root}" >/dev/null

if (( offline )); then
  log "Offline setup selected; the source wallet and RPC cluster were not checked."
  log "Run qos wallet status when this computer has network access."
elif [[ "${profile}" == "devnet" && "${no_fund}" -eq 0 ]]; then
  log "Verifying Devnet and requesting ${airdrop_lamports} faucet lamports for the source wallet."
  if ! run_node bin/qos-wallet.js --home "${qos_home}" fund-devnet --lamports "${airdrop_lamports}" --confirm-airdrop; then
    warn "The Devnet faucet or RPC did not complete funding. Setup will continue without pretending the wallet is ready."
    warn "Run qos wallet fund ${airdrop_lamports} after setup to retry."
  fi
else
  log "Verifying the source wallet against the policy-pinned Solana cluster."
  if [[ "${profile}" == "mainnet-external" ]]; then
    if ! run_external_node bin/qos-wallet.js --home "${qos_home}" status; then
      warn "Cluster readiness could not be verified. qOS will still fail closed before preparing or signing an action."
      warn "Run qos wallet status to retry."
    fi
  elif ! run_node bin/qos-wallet.js --home "${qos_home}" status; then
    warn "Cluster readiness could not be verified. qOS will still fail closed before preparing or signing an action."
    warn "Run qos wallet status to retry."
  fi
fi

if (( interactive )); then
  if ask_yes_no "Configure an AI model now?" "yes"; then
    log "Opening model onboarding. Local Ollama-compatible inference is the default; commercial providers use your owner-only API key file."
    if ! run_node bin/qos-model.js --home "${qos_home}" onboard --wizard; then
      warn "Model onboarding did not complete. Setup will continue; run qos model onboard later."
    fi
  else
    log "Model setup skipped. Run qos model onboard at any time."
  fi
fi

if (( interactive )) && [[ -z "${agent_id}" ]]; then
  if ask_yes_no "Onboard an AI agent now?" "no"; then
    prompt_required "Agent ID (lowercase letters, digits, hyphens)"
    agent_id="${prompt_result}"
    prompt_default "Agent name" "${agent_id}"
    agent_name="${prompt_result}"
    if ask_yes_no "Require your approval before every agent action?" "yes"; then
      agent_approval="ask"
    else
      agent_approval="auto"
      cat <<'EOF'

Automatic mode allows every valid request inside the agent and qOS policy
limits to execute while the listener is running live. It is not arbitrary
signing, but it can move funds without another prompt.
EOF
      if ! ask_yes_no "Accept automatic in-policy execution for this agent?" "no"; then
        log "Agent onboarding cancelled; qOS setup will continue."
        agent_id=""
      else
        accept_auto=1
      fi
    fi
    if [[ -n "${agent_id}" ]]; then
      if [[ "${profile}" == "devnet" ]]; then
        default_agent_max="$(run_node --input-type=module -e 'import { loadPolicy } from "./src/policy.js"; process.stdout.write(loadPolicy(process.argv[1]).maxTransferLamports);' "${qos_home}/policy.json")"
      else
        default_agent_max="$(run_node --input-type=module -e 'import { loadPolicy } from "./src/policy.js"; process.stdout.write(loadPolicy(process.argv[1]).tokenTransfer.maxTransferAmount);' "${qos_home}/policy.json")"
      fi
      agent_asset="${profile_agent_asset}"
      printf 'Allowed action: %s (%s). This is the only transfer template enabled by this profile.\n' \
        "${profile_agent_action}" "${profile_agent_asset}"
      prompt_default "Maximum base units per request" "${default_agent_max}"
      agent_max_amount="${prompt_result}"
    fi
  fi
fi

if (( interactive )) && [[ -n "${agent_id}" && -z "${agent_max_amount}" ]]; then
  [[ -n "${agent_name}" ]] || agent_name="${agent_id}"
  if [[ "${profile}" == "devnet" ]]; then
    default_agent_max="$(run_node --input-type=module -e 'import { loadPolicy } from "./src/policy.js"; process.stdout.write(loadPolicy(process.argv[1]).maxTransferLamports);' "${qos_home}/policy.json")"
  else
    default_agent_max="$(run_node --input-type=module -e 'import { loadPolicy } from "./src/policy.js"; process.stdout.write(loadPolicy(process.argv[1]).tokenTransfer.maxTransferAmount);' "${qos_home}/policy.json")"
  fi
  agent_asset="${profile_agent_asset}"
  printf 'Allowed action: %s (%s). This is the only transfer template enabled by this profile.\n' \
    "${profile_agent_action}" "${profile_agent_asset}"
  prompt_default "Maximum base units per request for ${agent_id}" "${default_agent_max}"
  agent_max_amount="${prompt_result}"
  if [[ "${agent_approval}" == "auto" && "${accept_auto}" -eq 0 ]]; then
    if ask_yes_no "Accept automatic in-policy execution for ${agent_id}?" "no"; then
      accept_auto=1
    else
      die "Automatic first-agent onboarding was not acknowledged."
    fi
  fi
fi

if (( interactive )) && [[ -n "${agent_id}" ]]; then
  [[ -n "${agent_name}" ]] || agent_name="${agent_id}"
  [[ -n "${agent_asset}" ]] || agent_asset="${profile_agent_asset}"
  [[ -n "${agent_destination}" ]] \
    || agent_destination="$(run_node --input-type=module -e 'import { loadPolicy } from "./src/policy.js"; process.stdout.write(loadPolicy(process.argv[1]).allowedDestinations[0]);' "${qos_home}/policy.json")"
  [[ -n "${agent_strategy_id}" ]] \
    || agent_strategy_id="$(run_node --input-type=module -e 'import { loadPolicy } from "./src/policy.js"; process.stdout.write(String(loadPolicy(process.argv[1]).allowedStrategyIds[0]));' "${qos_home}/policy.json")"
  if [[ ! -e "${qos_home}/agents/${agent_id}/token" && ! -L "${qos_home}/agents/${agent_id}/token" ]]; then
    cat <<EOF

Agent ready to onboard
----------------------
ID:              ${agent_id}
Name:            ${agent_name}
Execution:       ${agent_approval}
Allowed action:  ${profile_agent_action}
Maximum amount:  ${agent_max_amount} base units
Destination:     ${agent_destination}
Strategy ID:     ${agent_strategy_id}
EOF
    if ! ask_yes_no "Create this scoped agent?" "yes"; then
      log "Agent onboarding cancelled; qOS setup will continue."
      agent_id=""
    fi
  fi
fi

if [[ -n "${agent_id}" ]]; then
  [[ "${agent_id}" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "Agent ID must start with a lowercase letter and contain at most 32 lowercase letters, digits, or hyphens."
  [[ -n "${agent_max_amount}" ]] || die "--agent-max-amount is required for first-agent onboarding."
  if [[ -e "${qos_home}/agents/${agent_id}/token" ]]; then
    existing_agent="$(run_node bin/qos-agent-control.js --home "${qos_home}" --json show "${agent_id}")" \
      || die "Existing agent ${agent_id} could not be validated."
    [[ "$(printf '%s\n' "${existing_agent}" | json_field maxAmount)" == "${agent_max_amount}" ]] \
      || die "Existing agent ${agent_id} has a different maximum amount; offboard it explicitly before changing scope."
    [[ "$(printf '%s\n' "${existing_agent}" | json_field approvalMode)" == "${agent_approval}" ]] \
      || die "Existing agent ${agent_id} has a different approval mode; offboard it explicitly before changing scope."
    [[ -z "${agent_name}" || "$(printf '%s\n' "${existing_agent}" | json_field name)" == "${agent_name}" ]] \
      || die "Existing agent ${agent_id} has a different name."
    [[ -z "${agent_asset}" || "$(printf '%s\n' "${existing_agent}" | json_field asset)" == "${agent_asset}" ]] \
      || die "Existing agent ${agent_id} has a different asset scope."
    [[ -z "${agent_destination}" || "$(printf '%s\n' "${existing_agent}" | json_field destination)" == "${agent_destination}" ]] \
      || die "Existing agent ${agent_id} has a different destination scope."
    [[ -z "${agent_strategy_id}" || "$(printf '%s\n' "${existing_agent}" | json_field strategyId)" == "${agent_strategy_id}" ]] \
      || die "Existing agent ${agent_id} has a different strategy scope."
    log "Agent ${agent_id} is already onboarded; preserving its credential and scope."
  else
    agent_args=(
      --home "${qos_home}"
      onboard
      --id "${agent_id}"
      --max-amount "${agent_max_amount}"
      --approval "${agent_approval}"
    )
    agent_args+=(--yes)
    [[ -z "${agent_name}" ]] || agent_args+=(--name "${agent_name}")
    [[ -z "${agent_asset}" ]] || agent_args+=(--asset "${agent_asset}")
    [[ -z "${agent_destination}" ]] || agent_args+=(--destination "${agent_destination}")
    [[ -z "${agent_strategy_id}" ]] || agent_args+=(--strategy-id "${agent_strategy_id}")
    (( ! accept_auto )) || agent_args+=(--accept-auto)
    log "Onboarding agent ${agent_id} and generating its revocable skill pack."
    run_node bin/qos-agent-control.js "${agent_args[@]}"
  fi
fi

if [[ "${QOS_AGENT_AUTOSERVE:-1}" != "0" && -f "${qos_home}/agents/registry.json" ]]; then
  installed_agent_count="$(run_node --input-type=module -e '
    import { listAgents } from "./src/agent-registry.js";
    process.stdout.write(String(listAgents(process.argv[1]).length));
  ' "${qos_home}")"
  if [[ "${installed_agent_count}" =~ ^[1-9][0-9]*$ ]]; then
    log "Ensuring the authenticated loopback REST and MCP service is running."
    run_node bin/qos-agent-control.js --home "${qos_home}" start
  fi
fi

if (( ! skip_firmware )); then
  if [[ "${profile}" == "devnet" ]]; then
    log "Building and provisioning the private single-link QEMU firmware ELF."
    run_node bin/qos-firmware-demo.js build --home "${qos_home}" --human
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
retire_legacy_launchers

log "Installed the single qOS command in ${bin_directory}."
log "Profile: ${qos_home}"
log "No asset transfer has been prepared, signed, or broadcast by setup."
if [[ "${profile}" == "devnet" ]]; then
  cat <<'EOF'

Setup complete. qOS will open on disposable Devnet.

Start here:
  capa              show exactly what this profile can do
  stat              show its address and key-custody status
  wal status        verify the source wallet on Devnet
  mod on             choose a local or commercial AI model
  ag on              onboard an agent with a guided wizard
  ag st              show the auto-started REST and MCP service
  fw off s 1000000  rehearse a transfer entirely offline
  h                 show every command
EOF
elif [[ "${profile}" == "mainnet-insecure" ]]; then
  cat <<'EOF'

Setup complete. qOS will open on mainnet with a locally generated software key.
The key is accessible to programs running as this user. qOS installed the
mainnet policy, simulation, agent, signing, submission, and confirmation paths.
Live actions remain blocked until `wal status` reports that the source wallet
and pinned Token-2022 accounts are ready.

Start here:
  capa              show mainnet capabilities and accessible key custody
  stat              inspect signer and privacy status
  wal status        show the exact SOL and qOS-token funding requirements
  mod on             choose a local or commercial AI model
  ag                 list managed agents and the required workflow
  ag on              onboard an agent after wallet blockers are resolved
  ag st              show the auto-started REST and MCP service
  ag re --confirm-live  explicitly enable live mainnet agent execution
  tok addr          show the pinned qOS Token-2022 account
  tok prep 1000000  prepare one token without signing or broadcasting
  h                 show every command
EOF
else
  cat <<'EOF'

Setup complete. qOS will open with public-only mainnet custody.
The private key was not imported and QEMU signing is disabled for mainnet.
Live actions remain blocked until `wal status` reports that the source wallet
and pinned Token-2022 accounts are ready.

Start here:
  capa              confirm mainnet-external custody
  stat              inspect signer and privacy status
  wal status        show the exact SOL and qOS-token funding requirements
  mod on             choose a local or commercial AI model
  ag                 list managed agents and the required workflow
  ag on              onboard an agent after wallet blockers are resolved
  ag st              show the auto-started REST and MCP service
  ag re --confirm-live  explicitly enable live mainnet agent execution
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
