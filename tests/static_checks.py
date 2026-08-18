#!/usr/bin/env python3
"""Static safety checks for the firmware starter; not cryptographic tests."""

import json
from pathlib import Path
from typing import Tuple

ROOT = Path(__file__).resolve().parents[1]


def require(path: str, needles: Tuple[str, ...]) -> None:
    text = (ROOT / path).read_text()
    for needle in needles:
        assert needle in text, f"{path}: missing {needle!r}"


def forbid(path: str, needles: Tuple[str, ...]) -> None:
    text = (ROOT / path).read_text()
    for needle in needles:
        assert needle not in text, f"{path}: forbidden {needle!r}"


def forbid_path(path: str) -> None:
    assert not (ROOT / path).exists(), f"{path}: retired file must not exist"


def main() -> None:
    require(
        "firmware/reset.S",
        (
            "csrw    mie, zero",
            "call    srtm_main",
            "call    platform_fail_closed",
            "fence.i",
        ),
    )
    require(
        "firmware/secure_boot.c",
        (
            "manifest_shape_is_valid",
            "secure_zero",
            "volatile uint8_t",
            "snapshot_manifest",
            "platform_lock_boot_source",
            "platform_validate_measure_and_lock_fdt",
            "platform_verify_mldsa65_manifest",
            "platform_commit_security_version",
            "platform_lock_root_secrets",
            "platform_configure_and_lock_pmp",
        ),
    )
    secure_boot = (ROOT / "firmware/secure_boot.c").read_text()
    assert secure_boot.index("platform_lock_boot_source(") < secure_boot.index("snapshot_manifest(&manifest)"), "boot source must be locked before manifest snapshot"
    assert secure_boot.index("snapshot_manifest(&manifest)") < secure_boot.index("platform_sha3_384("), "manifest snapshot must precede image hashing"
    forbid("firmware/include/platform.h", ("uint64_t platform_read_security_version(void)",))
    require(
        "docs/SIGNER_POLICY.md",
        (
            "not serialized arbitrary",
            "strictly increasing",
            "Sign arbitrary bytes",
            "fails closed",
        ),
    )
    require(
        "src/service.js",
        (
            "assertCluster",
            "validateIntent",
            "isBlockhashValid",
            "getFeeForMessage",
            "simulateTransaction",
            "confirmSignature",
            "EphemeralSession",
            "transactionRetained",
            "openSigner",
            "SnarkProofGate",
            "MAINNET_EXTERNAL_SIGNER_REQUIRED",
            'this.runtimeProfile?.profile === "mainnet-insecure"',
        ),
    )
    require("src/session.js", ("NONCE_REPLAY", "createHmac", "randomBytes(16)"))
    require(
        "src/signer.js",
        (
            "ExternalCommandSigner",
            "keyExportableToAgentProcess: false",
            "SIGNER_IDENTITY_MISMATCH",
            "SIGNATURE_SELF_CHECK_FAILED",
        ),
    )
    require(
        "src/key-store.js",
        (
            'createCipheriv("aes-256-gcm"',
            "scryptSync",
            "setAAD",
            "KEY_DECRYPTION_FAILED",
            "KEY_IDENTITY_MISMATCH",
        ),
    )
    require(
        "src/zk.js",
        (
            "groth16-bn254",
            "plonk-bn254",
            "verifyingKeySha256",
            "intentCommitment",
            "policyCommitment",
            "ZK_PROOF_INVALID",
        ),
    )
    require(
        "src/server.js",
        (
            "LOOPBACK_REQUIRED",
            "API_TOKEN_REQUIRED",
            'new TextDecoder("utf-8", { fatal: true })',
            "maxRequestsPerSocket",
            "QOS_API_TOKEN_FILE",
            "TRANSFER_ENCODING_FORBIDDEN",
            "CONTENT_LENGTH_REQUIRED",
        ),
    )
    require(
        "src/transaction.js",
        (
            "SYSTEM_PROGRAM_ID",
            "buildNativeTransferMessage",
            "parseNativeTransferMessage",
            "buildTokenTransferCheckedMessage",
            "parseTokenTransferCheckedMessage",
            "TransferChecked",
            "SIGNATURE_SELF_CHECK_FAILED",
            "MAX_TRANSACTION_BYTES",
        ),
    )
    require(
        "src/policy.js",
        (
            "TOKEN_CLUSTER_MISMATCH",
            "QOS_TOKEN_MINT",
            "allowedMintExtensions",
            "DESTINATION_NOT_ALLOWED",
            "NONCE",
            "FEE_LIMIT_EXCEEDED",
        ),
    )
    require(
        "src/token.js",
        (
            "associatedTokenAddress",
            "verifyTokenTransferAccounts",
            "MINT_EXTENSIONS_MISMATCH",
            "TOKEN_ACCOUNT_OWNER_MISMATCH",
            "TOKEN_ACCOUNT_DELEGATE_PRESENT",
            "TOKEN_ACCOUNT_EXTENSIONS_MISMATCH",
            "INSUFFICIENT_TOKEN_BALANCE",
        ),
    )
    require(
        "src/secure-file.js",
        (
            "O_NOFOLLOW",
            "sameFile",
            "sameVersion",
            "readSync",
            "metadata.nlink === 1",
            "requireSingleLink",
            "assertPrivateDirectory",
        ),
    )
    require(
        "src/runtime-profile.js",
        (
            "assertPrivateDirectory",
            "readSecureFile",
            "privateFile: true",
            "randomBytes(48)",
            "EXTERNAL_HOME_PRIVATE_FILES",
            "INSECURE_MAINNET_ACKNOWLEDGEMENT_REQUIRED",
            'profile === "mainnet-insecure"',
            "assertTrustedExecutable",
        ),
    )
    require(
        "firmware-demo/src/main.rs",
        (
            "QOS_FW:BOOT",
            "POLICY_SIGNER",
            "POLICY_DESTINATION",
            "NONCE_REPLAY",
            "build_transfer_message",
            "build_token_transfer_message",
            "POLICY_TOKEN_PROGRAM",
            "signing_key.sign(&message",
            "QOS_FW:REJECT",
            "wipe_mailbox",
            "KEY_MAGIC",
        ),
    )
    require(
        "bin/qos-firmware-demo.js",
        (
            "FIRMWARE_MEASUREMENT_MISMATCH",
            "verifyFirmwareTransaction",
            "clusterGenesisBytes",
            '"--locked"',
            '"verified-offline"',
            "networkVerified:",
            "simulateTransaction",
            "confirmSignature",
            "FIRMWARE_REPLAY_TEST_FAILED",
            "openRamBackedFile",
            "redactFirmwareOutput",
            "signature_hex",
            "MAINNET_QEMU_BROADCAST_FORBIDDEN",
            "isolatedCargo: true",
            "SAFE_TOOL_PATH",
            "CARGO_FIRMWARE_ELF",
            "installFirmwareElf",
        ),
    )
    require(
        "bin/qos-agent-demo.js",
        (
            "QosService",
            "confirm-live",
            "QOS_ENABLE_MAINNET_BROADCAST",
            "prepareTokenIntent",
            "submitIntent",
        ),
    )
    require(
        "bin/qos-shell.js",
        (
            "secure firmware shell",
            "COMMAND_ALIASES",
            '["capa", "capabilities"]',
            '["fw", "firmware"]',
            "BROADCAST_CONFIRMATION_REQUIRED",
            "LIVE_CONFIRMATION_REQUIRED",
            "DEX_TEMPLATE_NOT_INSTALLED",
            "INTERACTIVE_TTY_REQUIRED",
            "shell: false",
            "QOS_API_TOKEN_FILE",
            "qemu-firmware-rehearsal",
            "formatHuman",
            'bin/qos-agent-control.js',
            'bin/qos-model.js',
            'bin/qos-policy.js',
            'bin/qos-wallet.js',
        ),
    )
    require(
        "src/agent-registry.js",
        (
            "randomBytes(48)",
            "tokenSha256",
            "timingSafeEqual",
            "AUTO_APPROVAL_ACKNOWLEDGEMENT_REQUIRED",
            "validateAgentAction",
            "writePrivateJsonAtomic",
            "cannot request arbitrary signatures",
            "offboardAgent",
        ),
    )
    require(
        "src/agent-server.js",
        (
            "LOOPBACK_REQUIRED",
            "AGENT_UNAUTHORIZED",
            "POLICY_RELOAD_REQUIRED",
            "PENDING_TTL_MS",
            "LIVE_CONFIRMATION_REQUIRED",
            "getAgentRecord",
            "pending.clear()",
            "TRANSFER_ENCODING_FORBIDDEN",
            "MCP_PROTOCOL_VERSION",
            'url.pathname === "/mcp"',
            "qos_request_transfer",
            "mcp-protocol-version",
            "MCP_HEADER_MISMATCH",
        ),
    )
    require(
        "src/agent-daemon.js",
        (
            "startAgentDaemon",
            "stopAgentDaemon",
            "processIdentityMatches",
            "requestManagedShutdown",
            "O_NOFOLLOW",
        ),
    )
    require(
        "src/policy-store.js",
        (
            "EDITABLE_POLICY_FIELDS",
            "POLICY_FIELD_LOCKED",
            "validatePolicy",
            "writePrivateJsonAtomic",
            "externalSignerPolicySyncRequired",
        ),
    )
    require(
        "src/private-json.js",
        (
            "readSecureFile",
            "assertPrivateDirectory",
            "writePrivateJsonAtomic",
            "renameSync",
        ),
    )
    require(
        "src/wallet-onboarding.js",
        (
            "assertCluster",
            "minimumFeeReserveLamports",
            "source Token-2022 associated account does not exist",
            "fundDevnetWallet",
        ),
    )
    require(
        "bin/qos-agent-control.js",
        (
            "onboard",
            "offboard",
            "listen",
            "startAgentDaemon",
            "mcpEndpoint",
            "--accept-auto",
            "--confirm-live",
            "Operator API token file",
        ),
    )
    require(
        "bin/qos-policy.js",
        (
            "inline policy editor",
            "--confirm-policy-change",
            "external signer",
        ),
    )
    require(
        "bin/qos-wallet.js",
        (
            "source-wallet onboarding",
            "--confirm-airdrop",
            "walletReadiness",
        ),
    )
    require(
        "src/agent.js",
        (
            "transfer_qos",
            "AGENT_DESTINATION_FORBIDDEN",
            "AGENT_AMOUNT_MISMATCH",
            "AGENT_MODEL_REMOTE_FORBIDDEN",
        ),
    )
    require(
        "src/model-provider.js",
        (
            "api.openai.com",
            "api.anthropic.com",
            "generativelanguage.googleapis.com",
            "api.cohere.com",
            "custom-openai",
            "MODEL_ENDPOINT_TLS_REQUIRED",
            "CUSTOM_MODEL_ENDPOINT_ACKNOWLEDGEMENT_REQUIRED",
            "MODEL_CREDENTIAL_MISMATCH",
            "redirect: \"error\"",
            "responseMimeType",
        ),
    )
    require(
        "src/model-registry.js",
        (
            "model-providers",
            "api-key",
            "privateFile: true",
            "writePrivateJsonAtomic",
            "credentialSha256",
            "rotateModelProviderCredential",
            "removeModelProvider",
        ),
    )
    require(
        "bin/qos-model.js",
        (
            "model onboarding and BYOK control",
            "Choose a model provider",
            "qwen2.5:3b",
            "--api-key-file",
            "--allow-custom-endpoint",
            "configureModelProvider",
            "setDefaultModelProvider",
            "rotateModelProviderCredential",
            "removeModelProvider",
        ),
    )
    forbid("bin/qos-agent-demo.js", ("signer.pem", "privateKey", "signerKey"))
    require(
        "src/agent-security.js",
        (
            "synthetic-disposable-only",
            "PLAINTEXT_PRIVATE_KEY_EXPOSURE",
            "PASSPHRASE_EXPOSURE_DECRYPTS_KEY",
            "EXTERNAL_SIGNER_KEY_BOUNDARY",
            "MODEL_PROMPT_NO_KEY_MATERIAL",
        ),
    )
    require(
        "tests/agent-key-probe.js",
        (
            "qos-agent-security-",
            "emittedSecretBytes: false",
            "loadEncryptedPrivateKey",
        ),
    )
    require(
        "bin/qos-agent-security-audit.js",
        (
            "synthetic qOS homes",
            "never reads a user-supplied home",
            "runAgentSecurityAnalysis",
        ),
    )
    require(
        "src/external-setup.js",
        (
            "PUBLIC_KEY_REQUIRED",
            "EXTERNAL_HOME_PRIVATE_FILES",
            "associatedTokenAddress",
            "signerPublicKey",
        ),
    )
    require(
        "bin/qos-agent-external-setup.js",
        (
            "never reads signer.pem",
            "--public-key",
            "--create",
            "createExternalSignerHome",
        ),
    )
    forbid("bin/qos-agent-external-setup.js", ("writeNewEd25519Key", "loadPrivateKey", "sendTransaction", "QOS_ENABLE_MAINNET_BROADCAST"))
    forbid("src/agent-security.js", ("sendTransaction", "mainnet-beta", "QOS_ENABLE_MAINNET_BROADCAST"))
    require(
        "run-demo.sh",
        (
            "required_commands=(node cargo rustup make python3)",
            "if (( ! build_only )); then",
            "required_commands+=(qemu-system-riscv64)",
        ),
    )
    require(
        "setup.sh",
        (
            "install|uninstall",
            "--devnet",
            "--insecure",
            "--accept-insecure-risk",
            "--wizard",
            "--unattended",
            "--signer-guide",
            "--offline",
            "--no-fund",
            "--model-provider",
            "--model-api-key-file",
            "--model-api-key-env",
            "--model-api-key",
            "--allow-custom-model-endpoint",
            "cleanup_model_key_import",
            "chmod 0600 \"${model_key_import_path}\"",
            "--agent-id",
            "--agent-approval",
            "--accept-auto",
            'profile="mainnet-external"',
            'profile="mainnet-insecure"',
            "Mainnet key setup",
            "Use a key I already control (recommended)",
            "Generate a key for me (--insecure)",
            'insecure=1',
            "continuing with the --insecure mainnet setup",
            "INSECURE MAINNET KEY NOTICE",
            "retire_legacy_installer",
            ".qos-setup-backup",
            "authorize-and-sign-qos-intent",
            "Never use fixtures/external-signer.js for funds",
            "--install-toolchains",
            "make check",
            "write_launcher qos bin/qos-shell.js",
            "retire_legacy_launchers",
            "Configure an AI model now?",
            "uninstall_launchers",
            "unlink --",
            "FULL qOS PURGE",
            "qos-install-state.js",
            "No asset transfer has been prepared, signed, or broadcast by setup",
        ),
    )
    forbid(
        "setup.sh",
        (
            "write_launcher qos-core",
            "write_launcher qos-shell",
            "write_launcher qos-agent",
            "write_launcher qos-model",
            "write_launcher qos-policy",
            "write_launcher qos-wallet",
        ),
    )
    package = json.loads((ROOT / "package.json").read_text())
    assert package["bin"] == {"qos": "./bin/qos-shell.js"}, "package.json must expose only the qos command"
    require(
        "scripts/qos-install-state.js",
        (
            "stopAgentDaemon",
            "PROFILE_MARKER",
            "TOOLCHAIN_MARKER",
            "removeTree",
            "isSymbolicLink",
            "sourceCheckoutPreserved",
        ),
    )
    forbid_path("install.sh")
    require(
        "web/install.sh",
        (
            "Quantized-OS/qOS",
            "https://github.com/${GITHUB_REPOSITORY}/releases/latest/download",
            "--proto '=https'",
            "--tlsv1.2",
            "QOS_RELEASE_SHA256",
            "the latest GitHub Release does not provide qos-source.tar.gz",
            "the latest GitHub Release does not provide SHA256SUMS.txt",
            "source archive checksum mismatch",
            "--no-same-owner",
            'exec bash "${target}/setup.sh" install',
            'exec bash "${target}/setup.sh" install --wizard',
            "mainnet wizard first asks whether",
        ),
    )
    forbid(
        "web/install.sh",
        (
            "eval ",
            "curl |",
            "wget |",
        ),
    )
    require(
        "web/install-macos.sh",
        (
            "brew install lima",
            '--mount-none',
            "template:ubuntu-24.04",
            'limactl shell --start --tty=true',
            "https://qos.systems/install.sh",
            'sh -s -- "$@"',
            "asks whether to use your existing external key",
        ),
    )
    forbid("web/install-macos.sh", ("eval ", "--mount-writable"))
    require(
        "web/install-windows.ps1",
        (
            "wsl.exe",
            '--install", "-d", "Ubuntu-24.04"',
            "QOS_SETUP_MODE",
            '"devnet" { " -s -- --devnet" }',
            "https://qos.systems/install.sh",
            "default mainnet wizard asks whether",
        ),
    )
    forbid("web/install-windows.ps1", ("Invoke-Expression", "ExecutionPolicy Bypass"))
    require(
        "web/index.html",
        (
            "Choose your system.",
            'data-os="linux"',
            'data-os="macos"',
            'data-os="windows"',
            "https://qos.systems/install-macos.sh",
            "https://qos.systems/install-windows.ps1",
            "wizard first asks whether to use your existing external key or generate a local key",
            "Running a remote script is a trust decision.",
        ),
    )
    require(
        "scripts/build-web-release.py",
        (
            "https://github.com/Quantized-OS/qOS/releases/latest/download/qos-source.tar.gz",
            '"index.html"',
            '"install-macos.sh"',
            '"install-windows.ps1"',
            "RELEASE.json",
            "web-root",
        ),
    )
    forbid("scripts/build-web-release.py", ("build_source_archive", "write_bytes(archive)"))
    require(
        "scripts/build-github-release.py",
        (
            "build_source_archive",
            "qos-source.tar.gz",
            "SHA256SUMS.txt",
            "Quantized-OS/qOS",
        ),
    )
    require(
        ".github/workflows/release.yml",
        (
            "make check",
            "build-github-release.py",
            "gh release create",
            "qos-source.tar.gz",
            "SHA256SUMS.txt",
            "--verify-tag",
        ),
    )
    require(
        "docs/SIGNER_ADAPTER_SETUP.md",
        (
            "qOS does not bundle a production adapter",
            "authorize-and-sign-qos-intent",
            "fixtures/external-signer.js",
            "qos-intent-v1",
            "qos-policy-v1",
            "privacyProofVerified",
            "src/transaction.js",
            "src/subprocess.js",
        ),
    )
    require(
        "scripts/bootstrap-user-toolchain.sh",
        (
            "https://nodejs.org/dist/",
            "https://static.rust-lang.org/rustup/archive/",
            "sha256sum --check --status",
            'RUST_TOOLCHAIN="1.97.1"',
            'NODE_VERSION="24.19.0"',
            'RUSTUP_VERSION="1.29.0"',
            "--no-modify-path",
        ),
    )
    require(
        "rust-toolchain.toml",
        (
            'channel = "1.97.1"',
            'profile = "minimal"',
            'targets = ["riscv64imac-unknown-none-elf"]',
        ),
    )
    require(".node-version", ("24.19.0",))
    forbid(
        "scripts/bootstrap-user-toolchain.sh",
        (
            "sh.rustup.rs",
            "| /bin/sh",
            "| bash",
            "eval ",
        ),
    )
    forbid("firmware-demo/build.rs", ("QOS_FW_SEED_HEX", "POLICY_SEED"))
    forbid("bin/qos-firmware-demo.js", ("INTENT_FILE", "intents.bin"))
    forbid("src/service.js", ("authorizeAndAppend", "auditRecords"))
    forbid("src/subprocess.js", ("shell: true",))
    forbid("firmware-demo/src/main.rs", ("tx_hex=",))
    forbid_path("src/audit.js")
    forbid_path("test/audit.test.js")
    require(
        "scripts/build-release.py",
        (
            "validate_release_tree",
            "PRIVATE_KEY_MARKERS",
            'ROOT / "docs" / "reports" / "RELEASE_READINESS.md"',
            'path.name in {"setup.sh", "run-demo.sh"}',
        ),
    )
    forbid(
        "scripts/setup-ubuntu-20.04.sh",
        (
            "nodesource.com/setup_",
            "https://sh.rustup.rs",
            'source "${cargo_home}/env"',
        ),
    )
    forbid("run-demo.sh", ('source "${cargo_home}/env"',))
    print("PASS: fail-closed boot, firmware, wallet, policy, agent lifecycle, cross-platform browser bootstraps, native SOL, and pinned Token-2022 checks")


if __name__ == "__main__":
    main()
