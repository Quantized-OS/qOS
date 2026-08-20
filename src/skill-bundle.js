import { assertQos } from "./errors.js";

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeEntries(files) {
  assertQos(files && typeof files === "object" && !Array.isArray(files), "INVALID_SKILL_BUNDLE", "Skill bundle files must be an object");
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  assertQos(entries.length >= 1 && entries.length <= MAX_FILES, "INVALID_SKILL_BUNDLE", "Skill bundle file count is invalid");
  let total = 0;
  return entries.map(([name, value]) => {
    assertQos(FILE_NAME.test(name) && !name.includes("..") && !name.startsWith("/") && !name.endsWith("/"), "INVALID_SKILL_FILE", "Skill bundle contains an unsafe file name");
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8");
    assertQos(bytes.length <= MAX_FILE_BYTES, "SKILL_FILE_TOO_LARGE", `Skill file ${name} is too large`);
    total += bytes.length;
    assertQos(total <= MAX_BUNDLE_BYTES, "SKILL_BUNDLE_TOO_LARGE", "Skill bundle is too large");
    return { name, nameBytes: Buffer.from(name, "utf8"), bytes, crc: crc32(bytes) };
  });
}

export function buildSkillZip(files) {
  const entries = safeEntries(files);
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0x00210000, 10);
    localHeader.writeUInt32LE(entry.crc, 14);
    localHeader.writeUInt32LE(entry.bytes.length, 18);
    localHeader.writeUInt32LE(entry.bytes.length, 22);
    localHeader.writeUInt16LE(entry.nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, entry.nameBytes, entry.bytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0x00210000, 12);
    centralHeader.writeUInt32LE(entry.crc, 16);
    centralHeader.writeUInt32LE(entry.bytes.length, 20);
    centralHeader.writeUInt32LE(entry.bytes.length, 24);
    centralHeader.writeUInt16LE(entry.nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0o100600 * 65_536, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, entry.nameBytes);
    offset += localHeader.length + entry.nameBytes.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
