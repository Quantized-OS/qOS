#!/usr/bin/env python3
"""Static safety checks for the firmware starter; not cryptographic tests."""

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
            "platform_verify_mldsa65_manifest",
            "platform_commit_security_version",
            "platform_lock_root_secrets",
            "platform_configure_and_lock_pmp",
        ),
    )
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
            "INSUFFICIENT_TOKEN_BALANCE",
        ),
    )
    require(
        "firmware-demo/src/main.rs",
        (
            "QOS_FW:BOOT",
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
        ),
    )
    forbid("firmware-demo/build.rs", ("QOS_FW_SEED_HEX", "POLICY_SEED"))
    forbid("bin/qos-firmware-demo.js", ("INTENT_FILE", "intents.bin"))
    forbid("src/service.js", ("authorizeAndAppend", "auditRecords"))
    forbid_path("src/audit.js")
    forbid_path("test/audit.test.js")
    print("PASS: fail-closed boot, firmware demo, native SOL and pinned Token-2022 signer-policy checks")


if __name__ == "__main__":
    main()
