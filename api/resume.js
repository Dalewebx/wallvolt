// GET /api/resume/:address
// Returns on-chain resume — wallet identity card

const ALCHEMY_KEY = process.env.ALCHEMY_KEY || 'g17rCrDbjWmGVYzGUzDYY';

const KNOWN_PROTOCOLS = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap',
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch',
  '0x1111111254fb6c44bac0bed2854e76f90643097d': '1inch',
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 'Aave',
  '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b': 'Compound',
  '0x00000000219ab540356cbb839cbe05303d7705fa': 'ETH2 Staking',
};

async function alchemyRPC(method, params, network = 'eth-mainnet') {
  const res = await fetch(`https://${network}.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

export default async function handler(req, res) {
  const { address, chain = 'eth' } = req.query;

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const network = chain === 'polygon' ? 'polygon-mainnet' : chain === 'base' ? 'base-mainnet' : 'eth-mainnet';
  const chainSym = chain === 'polygon' ? 'MATIC' : 'ETH';

  try {
    const [txCountHex, balanceHex, sentTxs, receivedTxs, tokenData, nftData] = await Promise.all([
      alchemyRPC('eth_getTransactionCount', [address, 'latest'], network),
      alchemyRPC('eth_getBalance', [address, 'latest'], network),
      alchemyRPC('alchemy_getAssetTransfers', [{
        fromBlock: '0x0', fromAddress: address,
        category: ['external', 'erc20', 'erc721'],
        maxCount: '0x64', order: 'asc'
      }], network),
      alchemyRPC('alchemy_getAssetTransfers', [{
        fromBlock: '0x0', toAddress: address,
        category: ['external', 'erc20', 'erc721'],
        maxCount: '0x14', order: 'asc'
      }], network),
      alchemyRPC('alchemy_getTokensForOwner', [address, { withMetadata: true }], network).catch(() => ({ tokens: [] })),
      fetch(`https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForOwner?owner=${address}&pageSize=10`)
        .then(r => r.json()).catch(() => ({ totalCount: 0 }))
    ]);

    const txCount = parseInt(txCountHex, 16);
    const balanceEth = parseInt(balanceHex, 16) / 1e18;
    const sentList = sentTxs?.transfers || [];
    const receivedList = receivedTxs?.transfers || [];
    const tokens = tokenData?.tokens || [];

    // First and last activity
    const allTxs = [...sentList, ...receivedList].sort((a, b) =>
      new Date(a.metadata?.blockTimestamp || 0) - new Date(b.metadata?.blockTimestamp || 0)
    );
    const firstTx = allTxs[0];
    const lastTx = allTxs[allTxs.length - 1];

    const firstActivity = firstTx?.metadata?.blockTimestamp
      ? new Date(firstTx.metadata.blockTimestamp)
      : null;
    const lastActivity = lastTx?.metadata?.blockTimestamp
      ? new Date(lastTx.metadata.blockTimestamp)
      : null;

    const walletAgeMs = firstActivity ? Date.now() - firstActivity.getTime() : null;
    const walletAgeDays = walletAgeMs ? Math.floor(walletAgeMs / 86400000) : null;
    const walletAgeYears = walletAgeDays ? (walletAgeDays / 365).toFixed(1) : null;

    // Protocols used (from sent txs)
    const protocolsUsed = new Set();
    for (const tx of sentList) {
      if (tx.to && KNOWN_PROTOCOLS[tx.to.toLowerCase()]) {
        protocolsUsed.add(KNOWN_PROTOCOLS[tx.to.toLowerCase()]);
      }
    }

    // Top tokens by value (approximate — no prices here)
    const topTokens = tokens
      .filter(t => parseFloat(t.balance || 0) > 0)
      .slice(0, 5)
      .map(t => ({ symbol: t.symbol, name: t.name, balance: t.balance }));

    // NFT count
    const nftCount = nftData?.totalCount || 0;

    // Unique counterparties
    const counterparties = new Set([
      ...sentList.map(t => t.to).filter(Boolean),
      ...receivedList.map(t => t.from).filter(Boolean)
    ]);

    // Days since last activity
    const daysSinceActive = lastActivity
      ? Math.floor((Date.now() - lastActivity.getTime()) / 86400000)
      : null;

    res.status(200).json({
      address,
      chain,
      resume: {
        walletAge: walletAgeDays ? {
          days: walletAgeDays,
          years: walletAgeYears,
          firstSeen: firstActivity?.toISOString().split('T')[0],
          lastActive: lastActivity?.toISOString().split('T')[0],
          daysSinceActive
        } : null,
        activity: {
          totalTransactions: txCount,
          sentTransactions: sentList.length,
          uniqueCounterparties: counterparties.size,
        },
        holdings: {
          nativeBalance: parseFloat(balanceEth.toFixed(4)),
          nativeSymbol: chainSym,
          tokenCount: tokens.length,
          nftCount,
          topTokens
        },
        protocols: Array.from(protocolsUsed),
        chains: [chain],
      },
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate resume' });
  }
}
