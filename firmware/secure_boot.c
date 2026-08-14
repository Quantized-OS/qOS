/* SPDX-License-Identifier: BSD-2-Clause */
#include "platform.h"

static int constant_time_equal(const uint8_t *left, const uint8_t *right,
                               size_t length) {
    uint32_t difference = 0;

    for (size_t i = 0; i < length; ++i) {
        difference |= (uint32_t)(left[i] ^ right[i]);
    }

    return difference == 0;
}

static bool add_overflows_uintptr(uintptr_t base, size_t length) {
    return length > UINTPTR_MAX - base;
}

static bool manifest_shape_is_valid(const struct srtm_manifest *manifest) {
    const uintptr_t expected_base = (uintptr_t)PLATFORM_IMAGE_ADDRESS;

    if (manifest->magic != SRTM_MANIFEST_MAGIC ||
        manifest->header_version != SRTM_HEADER_VERSION) {
        return false;
    }

    if (manifest->image_address != PLATFORM_IMAGE_ADDRESS ||
        manifest->image_length == 0 ||
        manifest->image_length > PLATFORM_IMAGE_MAX_BYTES) {
        return false;
    }

    if (manifest->image_length > SIZE_MAX ||
        add_overflows_uintptr(expected_base, (size_t)manifest->image_length)) {
        return false;
    }

    const uintptr_t image_end = expected_base + (size_t)manifest->image_length;
    if (manifest->image_entry < expected_base ||
        manifest->image_entry >= image_end ||
        (manifest->image_entry & 0x3u) != 0) {
        return false;
    }

    if (manifest->mldsa_signature_length != SRTM_MLDSA65_SIGNATURE_BYTES ||
        manifest->reserved != 0) {
        return false;
    }

    if (manifest->security_version < platform_read_security_version()) {
        return false;
    }

    return true;
}

/*
 * Called from reset.S with a0 containing the FDT pointer.  Returns the verified
 * OpenSBI entry address, or never returns on failure.
 */
uintptr_t srtm_main(uintptr_t fdt_address) {
    (void)fdt_address;

    const struct srtm_manifest *manifest =
        (const struct srtm_manifest *)(uintptr_t)PLATFORM_MANIFEST_ADDRESS;
    uint8_t computed_digest[SRTM_SHA3_384_BYTES];

    if (!manifest_shape_is_valid(manifest)) {
        platform_fail_closed(1, 0);
    }

    if (!platform_sha3_384(
            (const void *)(uintptr_t)manifest->image_address,
            (size_t)manifest->image_length,
            computed_digest)) {
        platform_fail_closed(2, 0);
    }

    if (!constant_time_equal(computed_digest, manifest->image_sha3_384,
                             sizeof(computed_digest))) {
        platform_fail_closed(3, 0);
    }

    /*
     * The platform verifier must validate a canonical, domain-separated
     * transcript of every security-relevant header field plus the digest.
     * It must not verify the in-memory C struct bytes directly.
     */
    if (!platform_verify_mldsa65_manifest(manifest)) {
        platform_fail_closed(4, 0);
    }

    if (!platform_extend_boot_measurement(computed_digest)) {
        platform_fail_closed(5, 0);
    }

    if (!platform_lock_root_secrets()) {
        platform_fail_closed(6, 0);
    }

    if (!platform_configure_and_lock_pmp(
            (uintptr_t)manifest->image_address,
            (size_t)manifest->image_length)) {
        platform_fail_closed(7, 0);
    }

    /* Commit last; the update must still be atomic and power-loss safe. */
    if (!platform_commit_security_version(manifest->security_version)) {
        platform_fail_closed(8, 0);
    }

    for (size_t i = 0; i < sizeof(computed_digest); ++i) {
        computed_digest[i] = 0;
    }
    __asm__ volatile("fence rw, rw" ::: "memory");

    return (uintptr_t)manifest->image_entry;
}
