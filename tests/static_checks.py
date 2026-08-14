#!/usr/bin/env python3
"""Static safety checks for the firmware starter; not cryptographic tests."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(path: str, needles: tuple[str, ...]) -> None:
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
    print("PASS: fail-closed boot and narrow signer-policy checks")


if __name__ == "__main__":
    main()

