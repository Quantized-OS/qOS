#!/usr/bin/env python3
"""Build the qos.systems front page and thin platform bootstraps."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release-artifacts" / "web-root")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    legacy_releases = output / "releases"
    if legacy_releases.is_symlink() or (legacy_releases.exists() and not legacy_releases.is_dir()):
        raise RuntimeError("legacy web release path is not a regular directory")
    if legacy_releases.exists():
        shutil.rmtree(legacy_releases)

    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    website_files = ("index.html", "install.sh", "install-macos.sh", "install-windows.ps1")
    for name in website_files:
        destination = output / name
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            raise RuntimeError(f"web output path is not a regular file: {name}")
        shutil.copyfile(ROOT / "web" / name, destination)
    (output / "RELEASE.json").write_text(
        json.dumps({
            "version": version,
            "homepage": "index.html",
            "bootstrap": "install.sh",
            "bootstraps": {
                "linux": "install.sh",
                "macos": "install-macos.sh",
                "windows": "install-windows.ps1",
            },
            "repository": "https://github.com/Quantized-OS/qOS",
            "source": "https://github.com/Quantized-OS/qOS/releases/latest/download/qos-source.tar.gz",
            "checksums": "https://github.com/Quantized-OS/qOS/releases/latest/download/SHA256SUMS.txt",
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"qos.systems deployment tree written to {output}")


if __name__ == "__main__":
    main()
