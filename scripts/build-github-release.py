#!/usr/bin/env python3
"""Build deterministic assets for a Quantized-OS/qOS GitHub Release."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_release_builder():
    source = ROOT / "scripts" / "build-release.py"
    spec = importlib.util.spec_from_file_location("qos_release_builder", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load deterministic release builder")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "release-artifacts" / "github-release",
    )
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    builder = load_release_builder()
    archive = builder.build_source_archive(version)
    digest = hashlib.sha256(archive).hexdigest()
    (output / "qos-source.tar.gz").write_bytes(archive)
    (output / "SHA256SUMS.txt").write_text(
        f"{digest}  qos-source.tar.gz\n",
        encoding="ascii",
    )
    (output / "RELEASE.json").write_text(
        json.dumps({
            "version": version,
            "repository": "Quantized-OS/qOS",
            "source_asset": "qos-source.tar.gz",
            "source_sha256": digest,
            "checksums_asset": "SHA256SUMS.txt",
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"GitHub release assets written to {output}")


if __name__ == "__main__":
    main()
