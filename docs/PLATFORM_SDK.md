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
