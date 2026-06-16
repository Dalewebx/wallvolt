// GET /api/approvals?address=0x...&chain=eth
// Approval exposure calculator — free tier safe

const ALCHEMY_KEY = process.env.ALCHEMY_KEY || 'g17rCrDbjWmGVYzGUzDYY';
const CG_BASE = 'https://api.coingecko.com/api/v3';

const KNOWN_SAFE = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap Router',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch V5',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router2',
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 'Aave Token',
  '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b': 'Compound Comptroller',
};

const PRICE_IDS = {
  'USDC':'usd-coin','USDT':'tether','DAI':'dai','WETH':'ethereum',
  'ETH':'ethereum','WBTC':'wrapped-bitcoin','LINK':'chainlink',
  'UNI':'uniswap','AAVE':'aave','MATIC':'matic-network','WMATIC':'matic-network',
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

async function getRecentApprovalLogs(address, network) {
  const ownerPadded = '0x000000000000000000000000' + address.slice(2).toLowerCase();
  const approvalTopic = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
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
    const [approvalLogs, tokenData] = await Promise.all([
      getRecentApprovalLogs(address, network),
      alchemyRPC('alchemy_getTokensForOwner', [address, { withMetadata: true }], network)
        .catch(() => ({ tokens: [] }))
    ]);

    // Build token balance map
    const tokenBalanceMap = {};
    for (const t of (tokenData?.tokens || [])) {
      if (t.contractAddress) {
        tokenBalanceMap[t.contractAddress.toLowerCase()] = {
          symbol: t.symbol,
          balance: parseFloat(t.balance || 0),
          decimals: t.decimals || 18
        };
      }
    }

    // Fetch prices
    const symbols = [...new Set(Object.values(tokenBalanceMap).map(t => t.symbol).filter(s => PRICE_IDS[s]))];
    const cgIds = [...new Set(symbols.map(s => PRICE_IDS[s]).filter(Boolean))];
    let prices = {};
    if (cgIds.length > 0) {
      try {
        const r = await fetch(`${CG_BASE}/simple/price?ids=${cgIds.join(',')}&vs_currencies=usd`);
        prices = await r.json();
      } catch {}
    }

    function getUSDPrice(symbol) {
      const id = PRICE_IDS[symbol?.toUpperCase()];
      return id && prices[id] ? prices[id].usd : null;
    }

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
      const tokenInfo = tokenBalanceMap[token];
      let exposureUSD = null;
      if (tokenInfo) {
        const price = getUSDPrice(tokenInfo.symbol);
        if (price) {
          if (isUnlimited) {
            exposureUSD = tokenInfo.balance * price;
          } else {
            const allowance = Number(amount) / Math.pow(10, tokenInfo.decimals || 18);
            exposureUSD = Math.min(allowance, tokenInfo.balance) * price;
          }
        }
      }
      const riskLevel = isUnlimited && !isKnown ? 'high' : isKnown && !isUnlimited ? 'safe' : 'medium';
      approvals.push({
        token, tokenSymbol: tokenInfo?.symbol || null,
        tokenBalance: tokenInfo?.balance || null,
        spender, spenderName: KNOWN_SAFE[spender] || null,
        isUnlimited, isKnown, riskLevel,
        exposureUSD: exposureUSD ? parseFloat(exposureUSD.toFixed(2)) : null,
        blockNumber: parseInt(log.blockNumber, 16)
      });
    }

    const totalExposureUSD = approvals.reduce((s, a) => s + (a.exposureUSD || 0), 0);
    const highRiskExposure = approvals.filter(a => a.riskLevel === 'high').reduce((s, a) => s + (a.exposureUSD || 0), 0);

    res.status(200).json({
      address, chain,
      summary: {
        totalApprovals: approvals.length,
        highRisk: approvals.filter(a => a.riskLevel === 'high').length,
        medium: approvals.filter(a => a.riskLevel === 'medium').length,
        safe: approvals.filter(a => a.riskLevel === 'safe').length,
        totalExposureUSD: parseFloat(totalExposureUSD.toFixed(2)),
        highRiskExposureUSD: parseFloat(highRiskExposure.toFixed(2)),
        note: 'Scans recent blocks only on free tier'
      },
      approvals: approvals.sort((a, b) => {
        const o = { high: 0, medium: 1, safe: 2 };
        return o[a.riskLevel] - o[b.riskLevel];
      }),
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch approvals' });
  }
}
