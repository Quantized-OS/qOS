#!/usr/bin/env python3
"""Static safety checks for the firmware starter; not cryptographic tests."""

from pathlib import Path
from typing import Tuple

ROOT = Path(__file__).resolve().parents[1]


def require(path: str, needles: Tuple[str, ...]) -> None:
    text = (ROOT / path).read_text()
    for needle in needles:
        assert needle in text, f"{path}: missing {needle!r}"


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
            "authorizeAndAppend",
        ),
    )
    require(
        "src/transaction.js",
        (
            "SYSTEM_PROGRAM_ID",
            "buildNativeTransferMessage",
            "parseNativeTransferMessage",
            "SIGNATURE_SELF_CHECK_FAILED",
            "MAX_TRANSACTION_BYTES",
        ),
    )
    require(
        "src/policy.js",
        (
            "MAINNET_DISABLED",
            "DESTINATION_NOT_ALLOWED",
            "NONCE",
            "FEE_LIMIT_EXCEEDED",
        ),
    )
    require(
        "firmware-demo/src/main.rs",
        (
            "QOS_FW:BOOT",
            "POLICY_DESTINATION",
            "NONCE_REPLAY",
            "build_transfer_message",
            "signing_key.sign(&message",
            "QOS_FW:REJECT",
        ),
    )
    require(
        "bin/qos-firmware-demo.js",
        (
            "FIRMWARE_MEASUREMENT_MISMATCH",
            "verifyFirmwareTransaction",
            "simulateTransaction",
            "confirmSignature",
            "FIRMWARE_REPLAY_TEST_FAILED",
        ),
    )
    print("PASS: fail-closed boot, firmware demo, Solana template, and narrow signer-policy checks")


if __name__ == "__main__":
    main()
