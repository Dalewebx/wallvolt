// GET /api/score/:address
// Returns wallet trust score with positive and negative signals

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

export default async function handler(req, res) {
  const { address, chain = 'eth' } = req.query;

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const network = chain === 'polygon' ? 'polygon-mainnet' : chain === 'base' ? 'base-mainnet' : 'eth-mainnet';

  try {
    // Fetch data in parallel
    const [txCountHex, balanceHex, approvalLogs] = await Promise.all([
      alchemyRPC('eth_getTransactionCount', [address, 'latest'], network),
      alchemyRPC('eth_getBalance', [address, 'latest'], network),
      alchemyRPC('eth_getLogs', [{
        fromBlock: 'earliest',
        toBlock: 'latest',
        topics: [
          '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
          '0x000000000000000000000000' + address.slice(2).toLowerCase(),
          null
        ]
      }], network)
    ]);

    const txCount = parseInt(txCountHex, 16);
    const balanceEth = parseInt(balanceHex, 16) / 1e18;

    // Parse approvals
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

    // Score calculation
    let score = 50; // base
    const positives = [];
    const negatives = [];

    // Wallet age / activity
    if (txCount >= 500) { score += 15; positives.push(`Very active wallet (${txCount.toLocaleString()} transactions)`); }
    else if (txCount >= 100) { score += 10; positives.push(`Active wallet (${txCount.toLocaleString()} transactions)`); }
    else if (txCount >= 20) { score += 5; positives.push(`Established wallet (${txCount.toLocaleString()} transactions)`); }
    else if (txCount < 5) { score -= 5; negatives.push('Very low transaction count — new or rarely used wallet'); }

    // Known protocol interactions
    const knownApprovals = approvals.filter(a => a.isKnown);
    const unknownApprovals = approvals.filter(a => !a.isKnown);
    const unlimitedUnknown = approvals.filter(a => a.isUnlimited && !a.isKnown);

    if (knownApprovals.length > 0) {
      score += Math.min(10, knownApprovals.length * 3);
      positives.push(`Interacts with ${knownApprovals.length} verified protocol${knownApprovals.length > 1 ? 's' : ''}`);
    }

    // Balance signals
    if (balanceEth >= 10) { score += 8; positives.push('Significant ETH balance'); }
    else if (balanceEth >= 1) { score += 4; positives.push('Holds meaningful ETH balance'); }
    else if (balanceEth < 0.01 && txCount > 10) { score -= 3; negatives.push('Very low ETH balance relative to activity'); }

    // Approval risks
    if (unlimitedUnknown.length === 0 && approvals.length > 0) {
      score += 8; positives.push('No unlimited approvals to unverified contracts');
    }
    if (unlimitedUnknown.length >= 3) {
      score -= 20; negatives.push(`${unlimitedUnknown.length} unlimited approvals to unverified contracts`);
    } else if (unlimitedUnknown.length > 0) {
      score -= unlimitedUnknown.length * 6;
      negatives.push(`${unlimitedUnknown.length} unlimited approval${unlimitedUnknown.length > 1 ? 's' : ''} to unverified contract${unlimitedUnknown.length > 1 ? 's' : ''}`);
    }

    if (unknownApprovals.length >= 5) {
      score -= 5; negatives.push(`${unknownApprovals.length} approvals to unverified contracts`);
    }

    if (approvals.length === 0) {
      score += 5; positives.push('No active token approvals — clean approval history');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    const level = score >= 75 ? 'trusted' : score >= 50 ? 'moderate' : 'caution';
    const label = score >= 75 ? 'Trusted Wallet' : score >= 50 ? 'Moderate Trust' : 'Use Caution';

    res.status(200).json({
      address,
      chain,
      score,
      level,
      label,
      positives,
      negatives,
      meta: {
        txCount,
        balanceEth: parseFloat(balanceEth.toFixed(4)),
        totalApprovals: approvals.length,
        unlimitedUnknownApprovals: unlimitedUnknown.length,
        knownProtocolApprovals: knownApprovals.length
      },
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to compute score' });
  }
}
