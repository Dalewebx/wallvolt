// GET /api/risk?address=0x...&chain=eth
// Approval risk analysis — free tier safe

const ALCHEMY_KEY = process.env.ALCHEMY_KEY || 'g17rCrDbjWmGVYzGUzDYY';

const KNOWN_SAFE = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap Router',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch V5',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router2',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap Universal Router',
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

async function scanRecentLogs(address, topic, network, extraTopic = null) {
  const ownerPadded = '0x000000000000000000000000' + address.slice(2).toLowerCase();
  const topics = extraTopic
    ? [topic, ownerPadded, null]
    : [topic, ownerPadded, null];

  try {
    const currentBlockHex = await alchemyRPC('eth_blockNumber', [], network);
    const currentBlock = parseInt(currentBlockHex, 16);
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
          topics
        }], network);
        if (chunk?.length) logs = [...logs, ...chunk];
      } catch { continue; }
    }
    return logs;
  } catch { return []; }
}

async function checkGoPlus(address) {
  try {
    const res = await fetch(`https://api.gopluslabs.io/api/v1/address_security/${address}`);
    const data = await res.json();
    return data.result || {};
  } catch { return {}; }
}

export default async function handler(req, res) {
  const { address, chain = 'eth' } = req.query;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const network = chain === 'polygon' ? 'polygon-mainnet' : chain === 'base' ? 'base-mainnet' : 'eth-mainnet';
  const approvalTopic = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const nftApprovalTopic = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';

  try {
    const [approvalLogs, nftLogs, goplusData] = await Promise.all([
      scanRecentLogs(address, approvalTopic, network),
      scanRecentLogs(address, nftApprovalTopic, network),
      checkGoPlus(address)
    ]);

    const seen = {};
    const approvals = [];

    // Parse ERC-20 approvals
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
      const signals = [];
      if (isUnlimited) signals.push('Unlimited spend permission');
      if (!isKnown) signals.push('Unverified contract');
      const riskLevel = isUnlimited && !isKnown ? 'high' : isKnown && !isUnlimited ? 'safe' : 'medium';
      approvals.push({
        type: 'ERC20', token, spender,
        isUnlimited, isKnown,
        knownName: KNOWN_SAFE[spender] || null,
        riskLevel, signals,
        blockNumber: parseInt(log.blockNumber, 16)
      });
    }

    // Parse NFT approvals
    for (const log of nftLogs) {
      if (!log.topics || log.topics.length < 3) continue;
      const spender = '0x' + log.topics[2].slice(26).toLowerCase();
      const token = log.address.toLowerCase();
      const key = 'nft_' + token + '_' + spender;
      if (seen[key]) continue;
      seen[key] = true;
      const approved = log.data === '0x0000000000000000000000000000000000000000000000000000000000000001';
      if (!approved) continue;
      const isKnown = !!KNOWN_SAFE[spender];
      approvals.push({
        type: 'NFT', token, spender,
        isUnlimited: true, isKnown,
        knownName: KNOWN_SAFE[spender] || null,
        riskLevel: isKnown ? 'medium' : 'high',
        signals: ['Full NFT collection access', ...(!isKnown ? ['Unverified contract'] : [])],
        blockNumber: parseInt(log.blockNumber, 16)
      });
    }

    const highRisk = approvals.filter(a => a.riskLevel === 'high');
    const mediumRisk = approvals.filter(a => a.riskLevel === 'medium');
    const safeApprovals = approvals.filter(a => a.riskLevel === 'safe');

    res.status(200).json({
      address, chain,
      summary: {
        total: approvals.length,
        high: highRisk.length,
        medium: mediumRisk.length,
        safe: safeApprovals.length,
        overallRisk: highRisk.length > 0 ? 'high' : mediumRisk.length > 2 ? 'medium' : 'safe',
        note: 'Scans recent blocks only on free tier — upgrade Alchemy for full history'
      },
      approvals,
      walletFlags: {
        isMalicious: goplusData.malicious_address === '1',
        isPhishing: goplusData.phishing_activities === '1',
        isSanctioned: goplusData.sanctioned === '1',
        honeypotRelated: goplusData.honeypot_related_address === '1',
        blacklisted: goplusData.blacklist_doubt === '1',
      },
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to analyse risk' });
  }
}
