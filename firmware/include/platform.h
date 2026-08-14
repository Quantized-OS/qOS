/* SPDX-License-Identifier: BSD-2-Clause */
#ifndef SSTA_PLATFORM_H
#define SSTA_PLATFORM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SRTM_MANIFEST_MAGIC UINT32_C(0x5352544d) /* "SRTM" */
#define SRTM_HEADER_VERSION UINT32_C(1)
#define SRTM_SHA3_384_BYTES 48u
#define SRTM_MLDSA65_SIGNATURE_BYTES 3309u

/* Replace these QEMU-development addresses in a real SoC port. */
#define PLATFORM_MANIFEST_ADDRESS UINT64_C(0x80200000)
#define PLATFORM_IMAGE_ADDRESS    UINT64_C(0x80400000)
#define PLATFORM_IMAGE_MAX_BYTES  UINT64_C(0x01000000)

struct srtm_manifest {
    uint32_t magic;
    uint32_t header_version;
    uint64_t image_address;
    uint64_t image_length;
    uint64_t image_entry;
    uint64_t security_version;
    uint8_t image_sha3_384[SRTM_SHA3_384_BYTES];
    uint32_t mldsa_signature_length;
    uint32_t reserved;
    uint8_t mldsa_signature[SRTM_MLDSA65_SIGNATURE_BYTES];
};

/*
 * Every hook below is security-critical and platform-specific.  A production
 * port should bind them to ROM keys, one-time-programmable rollback state,
 * a vetted FIPS 204 implementation, measured boot storage, and RISC-V PMP.
 */
bool platform_sha3_384(const void *data, size_t length,
                       uint8_t digest[SRTM_SHA3_384_BYTES]);

bool platform_verify_mldsa65_manifest(const struct srtm_manifest *manifest);

uint64_t platform_read_security_version(void);
bool platform_commit_security_version(uint64_t new_version);

bool platform_extend_boot_measurement(
    const uint8_t digest[SRTM_SHA3_384_BYTES]);

bool platform_lock_root_secrets(void);
bool platform_configure_and_lock_pmp(uintptr_t image_address,
                                     size_t image_length);

void platform_fail_closed(uintptr_t reason, uintptr_t detail)
    __attribute__((noreturn));

#endif
