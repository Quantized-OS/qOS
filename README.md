# Solana Secure Trading Appliance starter

This is an RV64 firmware and architecture starter for a secure, privately
routed Solana trading appliance.  It deliberately separates:

- Post-quantum verified boot
- OpenSBI and a minimal supervisor-mode OS
- An unprivileged trading engine
- A hardware-isolated Solana policy signer
- A private transaction relay client

The assembly file is the machine-mode reset entry.  It clears firmware state,
installs a fail-closed trap, calls the static root-of-trust verifier, and enters
only a verified OpenSBI image.

## Important limits

This is not production firmware and not a complete trading system.  The build
intentionally refuses to link until the target SoC supplies real implementations
for ML-DSA-65 verification, SHA3-384, rollback protection, measurements, PMP
locking, and fail-closed reset behavior.

Solana transactions currently contain 64-byte Ed25519 signatures.  ML-DSA can
protect firmware and update images, but the live transaction signer must still
produce the signature accepted by Solana.  A private relay reduces pre-inclusion
exposure; it does not hide a finalized transaction from the public ledger.

## Files

- `firmware/reset.S` — RV64 machine-mode reset entry
- `firmware/secure_boot.c` — bounds, digest, signature, rollback, and lock flow
- `firmware/include/platform.h` — security-critical SoC interface
- `firmware/linker.ld` — QEMU-oriented development memory layout
- `docs/ARCHITECTURE.md` — end-to-end trust boundaries
- `docs/SIGNER_POLICY.md` — narrow Solana signing interface
- `tests/static_checks.py` — starter invariants

## Run the available checks

```sh
make check
```

To compile the two firmware objects, install a `riscv64-linux-gnu-` toolchain:

```sh
make build/reset.o build/secure_boot.o
```

Do not add a development signature bypass.  Implement the platform hooks and
test verified boot, corrupted images, rollback, partial updates, power loss,
PMP lock behavior, and fault injection before attempting to boot an OS.

The next software milestone should be an unprivileged devnet-only order builder
and a mock signer that enforces `docs/SIGNER_POLICY.md`.  Mainnet support should
wait until message parsing, transaction templates, custody, and relay behavior
have independent review.

## Primary references

- NIST FIPS 204, ML-DSA: https://csrc.nist.gov/pubs/fips/204/final
- RISC-V OpenSBI: https://github.com/riscv-software-src/opensbi
- Solana transaction structure: https://solana.com/docs/core/transactions/transaction-structure
- Solana production signing: https://solana.com/docs/core/transactions/signing-in-production
- Solana Confidential Transfer: https://solana.com/docs/tokens/extensions/confidential-transfer
- Jito low-latency transaction send: https://docs.jito.wtf/lowlatencytxnsend/
