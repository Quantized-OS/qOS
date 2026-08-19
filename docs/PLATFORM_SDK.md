# qOS platform SDK

The qOS repository exposes one supported Node.js integration boundary for
independent host services:

```js
import {
  QOS_PLATFORM_SDK_VERSION,
  QosService,
  changePolicyDestination,
  configureModelProvider,
  ensureRuntimeProfile,
  initializeSandbox,
  onboardAgent,
} from "qos-solana-sandbox/platform-sdk";
```

`changePolicyDestination(home, "add" | "remove", publicKey)` is the validated,
atomic SDK surface for services that need more than one reviewed token
destination. It preserves the policy's non-empty allowlist and all locked
transaction-template fields.

`QosService.walletAssets(owner)` returns native SOL plus nonzero SPL Token and
Token-2022 accounts owned by the supplied wallet. It validates token accounts,
loads mint decimals in bounded batches, and marks an asset withdrawable only
when the mint and token program pass the reviewed parsers.

`QosService.prepareCloudWithdrawalIntent(options)` builds a version-4 typed
withdrawal intent for one selected inventory asset. It supports native SOL and
SPL/Token-2022 `TransferChecked`, creates missing destination associated token
accounts idempotently, and binds the connected-wallet destination, allowlisted
treasury, gross amount, and cumulative-exact 25-basis-point fee. The normal
simulate, sign, submit, confirm, and forget path remains authoritative.

Managed hosts may start an agent listener with `--managed-proxy` only when
`QOS_ENABLE_MANAGED_PROXY=I_UNDERSTAND` is also set. This permits `0.0.0.0`
inside an isolated runtime while rejecting public client addresses; the host
must publish the port on loopback and provide its own external authentication.
The ordinary self-hosted listener remains loopback-only.

The package export maps `qos-solana-sandbox/platform-sdk` to
`src/platform-sdk.js`. Consumers must not import other `src/*` paths or assume a
qOS checkout is inside their own repository.

`QOS_PLATFORM_SDK_VERSION` is independent of the package version. A consumer
must reject SDK versions it has not reviewed. Adding exports without changing
existing behavior is compatible; removing an export or changing its contract
requires a new SDK version.

## Repository boundary

qOS owns firmware, self-hosted installation, the restricted shell, model and
agent configuration, signer policy, Solana message construction, and the
atomic settlement template. It intentionally does not own websites, customer
accounts, hosted API sessions, market-price retrieval, runtime metering,
billing ledgers, infrastructure orchestration, or managed-service deployment.

The independent qOS Cloud project consumes this SDK from a pinned qOS release.
Local development may install a sibling checkout, but production should use a
reviewed commit or release artifact and record that qOS version alongside the
Cloud release.
