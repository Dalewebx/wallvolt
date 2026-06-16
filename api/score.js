// GET /api/score?address=0x...&chain=eth
// Wallet trust score — free tier safe (no eth_getLogs from earliest)

const ALCHEMY_KEY = process.env.ALCHEMY_KEY || 'g17rCrDbjWmGVYzGUzDYY';

const KNOWN_SAFE = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap Router',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch V5',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router2',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap Universal Router',
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 'Aave Token',
  '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b': 'Compound Comptroller',
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

async function getRecentApprovals(address, network) {
  const ownerPadded = '0x000000000000000000000000' + address.slice(2).toLowerCase();
  const approvalTopic = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

  try {
    const currentBlockHex = await alchemyRPC('eth_blockNumber', [], network);
    const currentBlock = parseInt(currentBlockHex, 16);
    // Scan last 90,000 blocks (~12 days) in 2000-block chunks
    const CHUNK = 2000;
    const LOOKBACK = 90000;
    const startBlock = Math.max(0, currentBlock - LOOKBACK);
    let logs = [];

    for (let end = currentBlock; end > startBlock && logs.length < 40; end -= CHUNK) {
      const start = Math.max(startBlock, end - CHUNK + 1);
      try {
        const chunk = await alchemyRPC('eth_getLogs', [{
          fromBlock: '0x' + start.toString(16),
          toBlock: '0x' + end.toString(16),
          topics: [approvalTopic, ownerPadded, null]
        }], network);
        if (chunk?.length) logs = [...logs, ...chunk];
      } catch { continue; }
    }
    return logs;
  } catch { return []; }
}

export default async function handler(req, res) {
  const { address, chain = 'eth' } = req.query;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const network = chain === 'polygon' ? 'polygon-mainnet' : chain === 'base' ? 'base-mainnet' : 'eth-mainnet';

  try {
    const [txCountHex, balanceHex, recentTxs, approvalLogs] = await Promise.all([
      alchemyRPC('eth_getTransactionCount', [address, 'latest'], network),
      alchemyRPC('eth_getBalance', [address, 'latest'], network),
      alchemyRPC('alchemy_getAssetTransfers', [{
        fromBlock: '0x0', fromAddress: address,
        category: ['external', 'erc20', 'erc721'],
        maxCount: '0x64', order: 'desc'
      }], network).catch(() => ({ transfers: [] })),
      getRecentApprovals(address, network)
    ]);

    const txCount = parseInt(txCountHex, 16);
    const balanceEth = parseInt(balanceHex, 16) / 1e18;
    const transfers = recentTxs?.transfers || [];

    // Parse recent approvals
    const seen = {};
    const approvals = [];
    for (const log of [...approvalLogs].reverse()) {
      if (!log.topics || log.topics.length < 3) continue;
      const spender = '0x' + log.topics[2].slice(26).toLowerCase();
      const token = log.address.toLowerCase();
      const key = token + '_' + spender;
      if (seen[key]) continue;
      seen[key] = true;
      const amount = log.data && log.data !== '0x'
        ? BigInt('0x' + log.data.slice(2).padStart(64, '0'))
        : BigInt(0);
      if (amount === BigInt(0)) continue;
      const isUnlimited = amount >= BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') / BigInt(2);
      const isKnown = !!KNOWN_SAFE[spender];
      approvals.push({ spender, token, isUnlimited, isKnown });
    }

    // Detect known protocol interactions from transfer history
    const protocolsUsed = new Set();
    for (const tx of transfers) {
      if (tx.to && KNOWN_SAFE[tx.to.toLowerCase()]) {
        protocolsUsed.add(KNOWN_SAFE[tx.to.toLowerCase()]);
      }
    }

    // Recent activity (last 30 days)
    const now = Date.now();
    const recent30 = transfers.filter(t =>
      t.metadata?.blockTimestamp &&
      now - new Date(t.metadata.blockTimestamp).getTime() < 30 * 86400000
    );

    // Score calculation
    let score = 50;
    const positives = [];
    const negatives = [];

    // Transaction history
    if (txCount >= 500) { score += 15; positives.push(`Very active wallet (${txCount.toLocaleString()} lifetime transactions)`); }
    else if (txCount >= 100) { score += 10; positives.push(`Active wallet (${txCount.toLocaleString()} lifetime transactions)`); }
    else if (txCount >= 20)  { score += 5;  positives.push(`Established wallet (${txCount} transactions)`); }
    else if (txCount < 5)   { score -= 5;  negatives.push('Very low transaction count — new or rarely used wallet'); }

    // Protocol interactions
    if (protocolsUsed.size > 0) {
      score += Math.min(10, protocolsUsed.size * 3);
      positives.push(`Interacts with verified protocols: ${Array.from(protocolsUsed).join(', ')}`);
    }

    // ETH balance
    if (balanceEth >= 10)   { score += 8; positives.push('Significant ETH balance'); }
    else if (balanceEth >= 1){ score += 4; positives.push('Holds meaningful ETH balance'); }
    else if (balanceEth < 0.01 && txCount > 10) { score -= 3; negatives.push('Very low ETH balance relative to activity'); }

    // Recent activity
    if (recent30.length >= 5) { score += 5; positives.push(`Recently active (${recent30.length} transactions in last 30 days)`); }
    else if (txCount > 20 && recent30.length === 0) { score -= 3; negatives.push('No recent activity in last 30 days'); }

    // Approval risks (from recent scan)
    const unlimitedUnknown = approvals.filter(a => a.isUnlimited && !a.isKnown);
    const knownApprovals = approvals.filter(a => a.isKnown);

    if (unlimitedUnknown.length === 0 && approvals.length > 0) {
      score += 5; positives.push('No unlimited approvals to unverified contracts (recent scan)');
    }
    if (knownApprovals.length > 0) {
      score += Math.min(8, knownApprovals.length * 2);
      positives.push(`${knownApprovals.length} approval${knownApprovals.length>1?'s':''} to verified protocols`);
    }
    if (unlimitedUnknown.length >= 3) {
      score -= 20; negatives.push(`${unlimitedUnknown.length} unlimited approvals to unverified contracts`);
    } else if (unlimitedUnknown.length > 0) {
      score -= unlimitedUnknown.length * 7;
      negatives.push(`${unlimitedUnknown.length} unlimited approval${unlimitedUnknown.length>1?'s':''} to unverified contract${unlimitedUnknown.length>1?'s':''}`);
    }

    if (approvals.length === 0) {
      positives.push('No recent approval events detected');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const level = score >= 75 ? 'trusted' : score >= 50 ? 'moderate' : 'caution';
    const label = score >= 75 ? 'Trusted Wallet' : score >= 50 ? 'Moderate Trust' : 'Use Caution';

    res.status(200).json({
      address, chain, score, level, label,
      positives, negatives,
      meta: {
        txCount,
        balanceEth: parseFloat(balanceEth.toFixed(4)),
        recentActivity: recent30.length,
        protocolsDetected: Array.from(protocolsUsed),
        recentApprovals: approvals.length,
        unlimitedUnknownApprovals: unlimitedUnknown.length,
        knownProtocolApprovals: knownApprovals.length,
        note: 'Approval scan covers recent blocks only on free tier'
      },
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to compute score' });
  }
}
