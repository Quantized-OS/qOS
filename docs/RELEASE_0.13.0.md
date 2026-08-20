# qOS firmware v0.13.0 — any-token trading MCP

qOS v0.13.0 replaces new-profile mint-pair allowlists with an `any-solana-token`
scope. Each swap request supplies distinct input and output mint addresses.
Before Jupiter receives an order request, firmware loads both accounts from the
policy-pinned mainnet RPC and accepts only initialized mints owned by Solana's
classic Token Program or Token-2022 Program.

Amount and operational controls remain enforced: per-trade input, per-pair UTC
daily input, trade count, cooldown, slippage, route fees, network/rent fees,
receiver, signer set, transaction version, and ambiguous-delivery reservation.
Legacy pair policies remain readable and keep their narrower scope.

New managed agents use `trading-only` scope. They expose no SOL or qOS transfer
tool. The MCP server adds standard skill resources, `qos_get_trading_skill`, an
authenticated `/skill` document, individual skill files, and a deterministic
ZIP download. Generated content includes the exact MCP URL, approval mode,
network, receiver, and every configured risk limit without embedding either
the MCP Bearer token or BYOK secret.

The qOS Cloud host contract is version 2. Cloud v0.8.0 or later is required for
new unrestricted-token profiles and generated skill downloads.
