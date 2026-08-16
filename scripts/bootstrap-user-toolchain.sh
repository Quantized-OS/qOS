#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly NODE_VERSION="24.19.0"
readonly RUSTUP_VERSION="1.29.0"
readonly RUST_TOOLCHAIN="1.97.1"
readonly RUST_TARGET="riscv64imac-unknown-none-elf"

log() {
  printf '[qOS toolchain] %s\n' "$*"
}

die() {
  printf '[qOS toolchain] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-user-toolchain.sh

Install the pinned qOS Node.js and Rust toolchains below the current user's
qOS data directory. Official artifacts and their official SHA-256 manifests
are downloaded over TLS; no downloaded shell script is executed.

Environment:
  QOS_TOOLCHAIN_ROOT   Override the absolute install root.
EOF
}

if (($#)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
fi

[[ "$(uname -s)" == "Linux" ]] || die "The pinned toolchain bootstrap currently supports Linux only."

case "$(uname -m)" in
  x86_64)
    node_arch="x64"
    rust_host="x86_64-unknown-linux-gnu"
    ;;
  aarch64|arm64)
    node_arch="arm64"
    rust_host="aarch64-unknown-linux-gnu"
    ;;
  *)
    die "Supported host architectures are x86_64 and aarch64."
    ;;
esac

for command_name in curl sha256sum tar xz; do
  command -v "${command_name}" >/dev/null 2>&1 || die "${command_name} is required before bootstrapping the user toolchain."
done

toolchain_root="${QOS_TOOLCHAIN_ROOT:-${HOME}/.local/share/qos/toolchains}"
[[ "${toolchain_root}" == /* ]] || die "QOS_TOOLCHAIN_ROOT must be an absolute path."
[[ ! -L "${toolchain_root}" ]] || die "QOS_TOOLCHAIN_ROOT must not be a symbolic link."
install -d -m 0700 "${toolchain_root}"
chmod 0700 "${toolchain_root}"
[[ "$(stat -c '%u' "${toolchain_root}")" == "$(id -u)" ]] || die "QOS_TOOLCHAIN_ROOT must be owned by the current user."

temporary_root="$(mktemp -d /tmp/qos-toolchain.XXXXXX)"
[[ "${temporary_root}" == /tmp/qos-toolchain.* && -d "${temporary_root}" ]] \
  || die "Could not allocate a bounded temporary toolchain directory."
cleanup() {
  rm -rf -- "${temporary_root}"
}
trap cleanup EXIT

download() {
  local url="$1"
  local destination="$2"
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --output "${destination}" "${url}"
}

verify_node_archive() {
  local checksum_file="$1"
  local archive="$2"
  local filename="$3"
  local expected
  local matches
  matches="$(awk -v filename="${filename}" '$2 == filename { count += 1; hash = $1 } END { print count + 0, hash }' "${checksum_file}")"
  [[ "${matches}" =~ ^1\ ([0-9a-f]{64})$ ]] || die "The Node.js checksum manifest did not contain exactly one canonical entry for ${filename}."
  expected="${BASH_REMATCH[1]}"
  printf '%s  %s\n' "${expected}" "${archive}" | sha256sum --check --status - \
    || die "Node.js archive SHA-256 verification failed."
}

verify_single_checksum() {
  local checksum_file="$1"
  local artifact="$2"
  local expected
  expected="$(awk 'NR == 1 && $1 ~ /^[0-9a-fA-F]{64}$/ { print tolower($1) }' "${checksum_file}")"
  [[ "${expected}" =~ ^[0-9a-f]{64}$ ]] || die "The Rust checksum manifest is malformed."
  [[ "$(awk 'NF { count += 1 } END { print count + 0 }' "${checksum_file}")" -eq 1 ]] || die "The Rust checksum manifest must contain exactly one record."
  printf '%s  %s\n' "${expected}" "${artifact}" | sha256sum --check --status - \
    || die "rustup-init SHA-256 verification failed."
}

node_directory="node-v${NODE_VERSION}-linux-${node_arch}"
node_home="${toolchain_root}/${node_directory}"
[[ ! -L "${node_home}" ]] || die "The Node.js toolchain path must not be a symbolic link."
if [[ -x "${node_home}/bin/node" && "$("${node_home}/bin/node" --version)" == "v${NODE_VERSION}" ]]; then
  log "Pinned Node.js v${NODE_VERSION} is already installed."
elif [[ -e "${node_home}" ]]; then
  die "Refusing to overwrite an invalid existing Node.js toolchain at ${node_home}."
else
  node_archive="${node_directory}.tar.xz"
  node_url="https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}"
  checksum_url="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  log "Downloading pinned Node.js v${NODE_VERSION} for linux-${node_arch}."
  download "${node_url}" "${temporary_root}/${node_archive}"
  download "${checksum_url}" "${temporary_root}/SHASUMS256.txt"
  verify_node_archive "${temporary_root}/SHASUMS256.txt" "${temporary_root}/${node_archive}" "${node_archive}"
  tar -xJf "${temporary_root}/${node_archive}" -C "${temporary_root}"
  [[ -x "${temporary_root}/${node_directory}/bin/node" ]] || die "The verified Node.js archive is missing its executable."
  [[ "$("${temporary_root}/${node_directory}/bin/node" --version)" == "v${NODE_VERSION}" ]] || die "The Node.js archive version does not match the pinned version."
  mv -- "${temporary_root}/${node_directory}" "${node_home}"
  chmod -R go-rwx "${node_home}"
fi

cargo_home="${toolchain_root}/cargo"
rustup_home="${toolchain_root}/rustup"
[[ ! -L "${cargo_home}" && ! -L "${rustup_home}" ]] || die "Rust toolchain directories must not be symbolic links."
install -d -m 0700 "${cargo_home}" "${rustup_home}"
chmod 0700 "${cargo_home}" "${rustup_home}"
[[ "$(stat -c '%u' "${cargo_home}")" == "$(id -u)" && "$(stat -c '%u' "${rustup_home}")" == "$(id -u)" ]] \
  || die "Rust toolchain directories must be owned by the current user."
rustup_binary="${cargo_home}/bin/rustup"
installed_rustup_version=""
if [[ -x "${rustup_binary}" ]]; then
  installed_rustup_version="$(CARGO_HOME="${cargo_home}" RUSTUP_HOME="${rustup_home}" "${rustup_binary}" --version | awk 'NR == 1 { print $2 }')"
fi

if [[ "${installed_rustup_version}" != "${RUSTUP_VERSION}" ]]; then
  rustup_url="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rust_host}/rustup-init"
  log "Downloading pinned rustup ${RUSTUP_VERSION} for ${rust_host}."
  download "${rustup_url}" "${temporary_root}/rustup-init"
  download "${rustup_url}.sha256" "${temporary_root}/rustup-init.sha256"
  verify_single_checksum "${temporary_root}/rustup-init.sha256" "${temporary_root}/rustup-init"
  chmod 0700 "${temporary_root}/rustup-init"
  CARGO_HOME="${cargo_home}" RUSTUP_HOME="${rustup_home}" \
    "${temporary_root}/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
fi

[[ -x "${rustup_binary}" ]] || die "rustup installation did not produce ${rustup_binary}."
rustup_env=(env -u RUSTUP_TOOLCHAIN CARGO_HOME="${cargo_home}" RUSTUP_HOME="${rustup_home}")
"${rustup_env[@]}" "${rustup_binary}" set auto-self-update disable
"${rustup_env[@]}" "${rustup_binary}" set auto-install disable
"${rustup_env[@]}" "${rustup_binary}" toolchain install "${RUST_TOOLCHAIN}" --profile minimal
"${rustup_env[@]}" "${rustup_binary}" default "${RUST_TOOLCHAIN}"
"${rustup_env[@]}" "${rustup_binary}" target add --toolchain "${RUST_TOOLCHAIN}" "${RUST_TARGET}"

rustc_binary="${cargo_home}/bin/rustc"
[[ -x "${rustc_binary}" ]] || die "Rust installation did not produce rustc."
[[ "$("${rustup_env[@]}" "${rustc_binary}" --version)" == rustc\ ${RUST_TOOLCHAIN}\ * ]] \
  || die "The installed Rust compiler does not match ${RUST_TOOLCHAIN}."

log "Verified user toolchain installed under ${toolchain_root}."
log "Node: $("${node_home}/bin/node" --version)"
log "Rust: $("${rustup_env[@]}" "${rustc_binary}" --version)"
