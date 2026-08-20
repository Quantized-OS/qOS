# qOS firmware v0.12.1 — live Cloud host contract

This release keeps qOS firmware and qOS Cloud as separate projects while
making their live-transaction boundary machine-verifiable.

- `qos-solana-sandbox/platform-sdk` now exports
  `QOS_CLOUD_HOST_CONTRACT_VERSION` and `assertCloudLiveTransactions()`.
- A managed Cloud control plane must acknowledge live mainnet transactions at
  startup. The firmware contract rejects a simulated-success configuration.
- Existing policy-gated qOS settlement, withdrawal, BYOK model, and bounded
  Jupiter DEX behavior is unchanged.

The host acknowledgement does not bypass qOS transaction validation. Every
settlement, withdrawal, transfer, and swap remains subject to its existing
firmware policy and exact transaction checks.
