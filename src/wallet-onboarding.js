export async function walletReadiness(service) {
  const [clusterGenesis, balanceLamports] = await Promise.all([
    service.assertCluster(),
    service.balance(),
  ]);
  const feeReserve = BigInt(service.policy.maxFeeLamports);
  const nativeEnabled = BigInt(service.policy.maxTransferLamports) > 0n;
  const blockers = [];
  const nextSteps = [];
  let token = null;
  if (balanceLamports < feeReserve || (nativeEnabled && balanceLamports <= feeReserve)) {
    blockers.push(nativeEnabled
      ? "source wallet needs more SOL than the configured maximum fee reserve before it can transfer"
      : "source wallet needs SOL for the configured maximum network fee");
    nextSteps.push(`Send SOL to source wallet ${service.publicKey} until it holds more than the ${service.policy.maxFeeLamports}-lamport fee reserve`);
  }
  if (service.policy.tokenTransfer !== null) {
    const addresses = service.tokenAddresses();
    const accountInfo = await service.rpc.getAccountInfo(addresses.tokenAccount);
    if (accountInfo === null) {
      token = {
        ...addresses,
        accountExists: false,
        amount: null,
        decimals: service.policy.tokenTransfer.decimals,
      };
      blockers.push("source Token-2022 associated account does not exist; send the pinned qOS token to the derived account through a trusted Solana wallet");
      nextSteps.push(`In a trusted Token-2022-capable wallet, send the pinned qOS mint ${addresses.mint} to owner ${service.publicKey} and allow that wallet to create associated account ${addresses.tokenAccount}`);
    } else {
      const balance = await service.tokenBalance();
      token = {
        ...addresses,
        accountExists: true,
        amount: balance.amount,
        decimals: balance.decimals,
      };
      if (BigInt(balance.amount) === 0n) blockers.push("source Token-2022 account has no qOS tokens");
    }
    const destinations = [];
    for (const owner of service.policy.allowedDestinations ?? []) {
      const destination = service.tokenAddresses(owner);
      const destinationInfo = await service.rpc.getAccountInfo(destination.tokenAccount);
      if (destinationInfo === null) {
        destinations.push({ ...destination, accountExists: false, amount: null });
        blockers.push(`destination ${owner} is missing its pinned qOS Token-2022 associated account`);
        nextSteps.push(`Create the pinned qOS Token-2022 account ${destination.tokenAccount} for destination owner ${owner} through a trusted wallet before using that destination`);
      } else {
        const destinationBalance = await service.tokenBalance(owner);
        destinations.push({
          ...destination,
          accountExists: true,
          amount: destinationBalance.amount,
          decimals: destinationBalance.decimals,
        });
      }
    }
    token.destinations = destinations;
  }
  if (blockers.length > 0) {
    nextSteps.push("Run qos wallet status again; start live agent execution only after status is ready");
  }
  return {
    status: blockers.length === 0 ? "ready" : "action-required",
    cluster: service.policy.cluster,
    clusterGenesis,
    signer: service.publicKey,
    rpcOrigin: new URL(service.policy.rpcUrl).origin,
    balanceLamports: balanceLamports.toString(),
    minimumFeeReserveLamports: service.policy.maxFeeLamports,
    nativeTransfersEnabled: nativeEnabled,
    token,
    blockers,
    nextSteps,
  };
}

export async function fundDevnetWallet(service, lamports = "200000000") {
  const airdrop = await service.airdrop(lamports);
  return {
    status: "funded",
    airdrop,
    readiness: await walletReadiness(service),
  };
}
