#!/usr/bin/env python3
"""Build deterministic qOS research source and ISO-9660 release media."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
import struct
import tarfile
from pathlib import Path


SECTOR_SIZE = 2048
ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_RELEASE_NAMES = {
    ".env",
    "audit.key",
    "api-token",
    "id_ed25519",
    "id_rsa",
    "passphrase",
    "provisioning.json",
    "receiver.pem",
    "receiver.qkey",
    "signer.json",
    "signer.pem",
    "signer.qkey",
}
FORBIDDEN_RELEASE_SUFFIXES = (".key", ".pem", ".qkey")
FORBIDDEN_RELEASE_NAME_PARTS = ("api-token", "passphrase")
PRIVATE_KEY_MARKERS = (
    b"-----BEGIN " b"PRIVATE KEY-----",
    b"-----BEGIN " b"ENCRYPTED PRIVATE KEY-----",
    b"-----BEGIN " b"OPENSSH PRIVATE KEY-----",
    b"-----BEGIN " b"EC PRIVATE KEY-----",
    b"-----BEGIN " b"RSA PRIVATE KEY-----",
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def excluded(relative: Path) -> bool:
    parts = relative.parts
    if any(part in {".git", "build", "release-artifacts", "node_modules", "__pycache__"} for part in parts):
        return True
    if any(part.startswith(".qos-") for part in parts):
        return True
    if len(parts) >= 2 and parts[:2] == ("firmware-demo", "target"):
        return True
    return False


def archive_entries() -> list[Path]:
    entries = []
    for path in sorted(ROOT.rglob("*")):
        relative = path.relative_to(ROOT)
        if excluded(relative) or path.is_symlink():
            continue
        if path.is_dir() or path.is_file():
            entries.append(path)
    return entries


def validate_release_tree(entries: list[Path]) -> None:
    for path in entries:
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        lower_name = path.name.lower()
        if (
            lower_name in FORBIDDEN_RELEASE_NAMES
            or lower_name.endswith(FORBIDDEN_RELEASE_SUFFIXES)
            or any(part in lower_name for part in FORBIDDEN_RELEASE_NAME_PARTS)
        ):
            raise ValueError(f"release tree contains runtime secret file: {relative}")
        data = path.read_bytes()
        if any(marker in data for marker in PRIVATE_KEY_MARKERS):
            raise ValueError(f"release tree contains private-key material: {relative}")


def normalized_tar_info(tar: tarfile.TarFile, path: Path, arcname: str) -> tarfile.TarInfo:
    info = tar.gettarinfo(str(path), arcname=arcname)
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = 0
    if info.isdir():
        info.mode = 0o755
    else:
        relative = path.relative_to(ROOT)
        executable = path.name in {"install.sh", "run-demo.sh"} or (
            relative.parts[0] in {"bin", "fixtures", "scripts"}
            and path.suffix in {".sh", ".py", ".js"}
        )
        info.mode = 0o755 if executable else 0o644
    return info


def build_source_archive(version: str) -> bytes:
    root_name = f"qos-{version}"
    entries = archive_entries()
    validate_release_tree(entries)
    tar_bytes = io.BytesIO()
    with tarfile.open(fileobj=tar_bytes, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        root_info = tarfile.TarInfo(root_name)
        root_info.type = tarfile.DIRTYPE
        root_info.mode = 0o755
        root_info.uid = 0
        root_info.gid = 0
        root_info.uname = "root"
        root_info.gname = "root"
        root_info.mtime = 0
        tar.addfile(root_info)
        for path in entries:
            relative = path.relative_to(ROOT).as_posix()
            info = normalized_tar_info(tar, path, f"{root_name}/{relative}")
            if info.isreg():
                with path.open("rb") as source:
                    tar.addfile(info, source)
            else:
                tar.addfile(info)

    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", filename="", mtime=0) as output:
        output.write(tar_bytes.getvalue())
    return compressed.getvalue()


def both_endian_u16(value: int) -> bytes:
    return struct.pack("<H", value) + struct.pack(">H", value)


def both_endian_u32(value: int) -> bytes:
    return struct.pack("<I", value) + struct.pack(">I", value)


def directory_record(extent: int, size: int, flags: int, identifier: bytes) -> bytes:
    padding = b"\0" if len(identifier) % 2 == 0 else b""
    record = bytearray(33 + len(identifier) + len(padding))
    record[0] = len(record)
    record[2:10] = both_endian_u32(extent)
    record[10:18] = both_endian_u32(size)
    record[18:25] = b"\0" * 7
    record[25] = flags
    record[26:28] = b"\0\0"
    record[28:32] = both_endian_u16(1)
    record[32] = len(identifier)
    record[33:33 + len(identifier)] = identifier
    return bytes(record)


def make_path_table(root_extent: int, little_endian: bool) -> bytes:
    byte_order = "<I" if little_endian else ">I"
    return bytes([1, 0]) + struct.pack(byte_order, root_extent) + struct.pack("<H" if little_endian else ">H", 1) + b"\0"


def make_iso(files: dict[str, bytes], volume_id: str) -> bytes:
    names = list(files)
    if len(names) != len(set(names)):
        raise ValueError("ISO file names must be unique")
    if any(name != name.upper() or len(name) > 12 for name in names):
        raise ValueError("ISO file names must be short uppercase names")

    pvd_sector = 16
    terminator_sector = 17
    little_path_sector = 18
    big_path_sector = 19
    root_sector = 20
    next_file_sector = 21
    placements: dict[str, tuple[int, int]] = {}
    for name, data in files.items():
        placements[name] = (next_file_sector, len(data))
        next_file_sector += max(1, math.ceil(len(data) / SECTOR_SIZE))

    root_records = [
        directory_record(root_sector, SECTOR_SIZE, 2, b"\0"),
        directory_record(root_sector, SECTOR_SIZE, 2, b"\1"),
    ]
    for name in names:
        extent, size = placements[name]
        root_records.append(directory_record(extent, size, 0, name.encode("ascii")))
    root_directory = b"".join(root_records)
    if len(root_directory) > SECTOR_SIZE:
        raise ValueError("release ISO root directory is too large")
    root_directory = root_directory.ljust(SECTOR_SIZE, b"\0")

    little_path = make_path_table(root_sector, True)
    big_path = make_path_table(root_sector, False)
    volume_sectors = next_file_sector

    pvd = bytearray(SECTOR_SIZE)
    pvd[0] = 1
    pvd[1:6] = b"CD001"
    pvd[6] = 1
    pvd[8:40] = b"QOS".ljust(32, b" ")
    pvd[40:72] = volume_id.encode("ascii")[:32].ljust(32, b" ")
    pvd[80:88] = both_endian_u32(volume_sectors)
    pvd[120:124] = both_endian_u16(1)
    pvd[124:128] = both_endian_u16(1)
    pvd[128:132] = both_endian_u16(SECTOR_SIZE)
    pvd[132:140] = both_endian_u32(len(little_path))
    pvd[140:144] = struct.pack("<I", little_path_sector)
    pvd[144:148] = b"\0" * 4
    pvd[148:152] = struct.pack(">I", big_path_sector)
    pvd[152:156] = b"\0" * 4
    pvd[156:190] = directory_record(root_sector, SECTOR_SIZE, 2, b"\0")

    terminator = bytearray(SECTOR_SIZE)
    terminator[0] = 255
    terminator[1:6] = b"CD001"
    terminator[6] = 1

    image = bytearray(volume_sectors * SECTOR_SIZE)
    image[pvd_sector * SECTOR_SIZE:(pvd_sector + 1) * SECTOR_SIZE] = pvd
    image[terminator_sector * SECTOR_SIZE:(terminator_sector + 1) * SECTOR_SIZE] = terminator
    image[little_path_sector * SECTOR_SIZE:little_path_sector * SECTOR_SIZE + len(little_path)] = little_path
    image[big_path_sector * SECTOR_SIZE:big_path_sector * SECTOR_SIZE + len(big_path)] = big_path
    image[root_sector * SECTOR_SIZE:(root_sector + 1) * SECTOR_SIZE] = root_directory
    for name, data in files.items():
        extent, _ = placements[name]
        start = extent * SECTOR_SIZE
        image[start:start + len(data)] = data
    return bytes(image)


def verify_iso(image: bytes, expected_names: set[str]) -> None:
    if len(image) % SECTOR_SIZE != 0 or image[16 * SECTOR_SIZE + 1:16 * SECTOR_SIZE + 6] != b"CD001":
        raise ValueError("generated artifact is not a valid ISO-9660 image")
    pvd = image[16 * SECTOR_SIZE:(17 * SECTOR_SIZE)]
    root = pvd[156:190]
    root_extent = struct.unpack("<I", root[2:6])[0]
    root_size = struct.unpack("<I", root[10:14])[0]
    directory = image[root_extent * SECTOR_SIZE:root_extent * SECTOR_SIZE + root_size]
    names = set()
    offset = 0
    while offset < len(directory):
        length = directory[offset]
        if length == 0:
            break
        record = directory[offset:offset + length]
        name_length = record[32]
        name = record[33:33 + name_length]
        if name not in {b"\0", b"\1"}:
            names.add(name.decode("ascii"))
        offset += length
    if names != expected_names:
        raise ValueError(f"ISO directory mismatch: {sorted(names)}")


def build_release(output: Path, version: str) -> None:
    output.mkdir(parents=True, exist_ok=True)
    source_name = f"qos-{version}-source.tar.gz"
    iso_name = f"qos-{version}-research-media.iso"
    source_path = output / source_name
    iso_path = output / iso_name
    iso_source_name = f"QOS{version.replace('.', '')[:8]}.TGZ"

    source_bytes = build_source_archive(version)
    source_path.write_bytes(source_bytes)
    source_hash = sha256_bytes(source_bytes)
    readiness = (ROOT / "docs" / "reports" / "RELEASE_READINESS.md").read_bytes()
    iso_readme = (
        f"qOS {version} research release media\n\n"
        "This ISO-9660 image is data media, not a bootable production firmware installer.\n"
        "It contains the deterministic source archive and the readiness report.\n"
        "Read docs/reports/RELEASE_READINESS.md in the source archive before any use.\n\n"
        f"Source archive SHA-256: {source_hash}\n"
    ).encode("utf-8")
    source_checksum = f"{source_hash}  {source_name}\n".encode("ascii")
    iso = make_iso({
        iso_source_name: source_bytes,
        "READY.TXT": readiness,
        "README.TXT": iso_readme,
        "SOURCE.SHA": source_checksum,
    }, f"QOS{version.replace('.', '')[:6]}MEDIA")
    verify_iso(iso, {iso_source_name, "READY.TXT", "README.TXT", "SOURCE.SHA"})
    iso_path.write_bytes(iso)

    manifest = {
        "version": version,
        "status": "research-demo-only",
        "source_archive": source_name,
        "source_sha256": source_hash,
        "iso": iso_name,
        "iso_sha256": sha256_file(iso_path),
        "iso_bootable": False,
    }
    (output / "RELEASE.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text(
        f"{source_hash}  {source_name}\n{manifest['iso_sha256']}  {iso_name}\n",
        encoding="ascii",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release-artifacts")
    parser.add_argument("--version", default=None)
    args = parser.parse_args()
    version = args.version or json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    if not isinstance(version, str) or not version or any(char not in "0123456789." for char in version):
        raise SystemExit("version must contain only digits and dots")
    build_release(args.output.resolve(), version)
    print(f"release artifacts written to {args.output.resolve()}")


if __name__ == "__main__":
    main()
