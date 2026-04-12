import { describe, it, expect, vi, beforeEach } from 'vitest'

// We mock @solana/web3.js at module scope so it works whether
// chain/state.ts uses static or dynamic imports.
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js')

  const mockConnection = {
    getAccountInfo: vi.fn(),
    getTokenAccountBalance: vi.fn(),
  }

  return {
    ...actual,
    Connection: vi.fn(() => mockConnection),
    __mockConnection: mockConnection,
  }
})

// Import chain/state after mocks are hoisted
import { fetchRebalanceChainState, fetchVaultEquity } from '../chain/state.js'
import { Connection } from '@solana/web3.js'

// Helper to retrieve the mock connection from the module mock
function getMockConnection() {
  // Vitest's module mock replaces Connection with a factory; calling new Connection()
  // returns the mock object we defined above via __mockConnection.
  const mod = vi.mocked(Connection) as unknown as { __mockConnection: ReturnType<typeof vi.fn> }
  return (mod as any).__mockConnection
}

// ─── Byte-level RiskVault builder ────────────────────────────────────────────
// RiskVault Anchor layout (all offsets post-8-byte discriminator):
//   disc(8) | version(1) | allocator(32) | risk_level(1) |
//   protocol_vault(32) | share_mint(32) |
//   total_shares(8) | total_assets(8) |
//   peak_equity(8) | current_equity(8) | equity_24h_ago(8) |
//   last_rebalance_slot(8) | rebalance_counter(4)
// => rebalance_counter offset = 8+1+32+1+32+32+8+8+8+8+8+8 = 154
const REBALANCE_COUNTER_OFFSET = 154

function buildRiskVaultData(rebalanceCounter: number): Buffer {
  // Allocate enough space (256 bytes is plenty)
  const buf = Buffer.alloc(256, 0)
  buf.writeUInt32LE(rebalanceCounter, REBALANCE_COUNTER_OFFSET)
  return buf
}

// ─── Byte-level Treasury builder ─────────────────────────────────────────────
// Treasury Anchor layout:
//   disc(8) | version(1) | allocator(32) | usdc_token_account(32)
// => usdc_token_account offset = 8+1+32 = 41
const TREASURY_USDC_OFFSET = 41
const FAKE_TREASURY_USDC = 'So11111111111111111111111111111111111111112'

function buildTreasuryData(usdcTokenAccount: string): Buffer {
  // Dynamically import PublicKey for key encoding — use real base58 decode
  // For tests we put a known 32-byte array so we can verify extraction.
  const buf = Buffer.alloc(200, 0)
  // Encode the pubkey bytes at the correct offset
  // We'll use a simple all-zeros + index pattern for test isolation
  // (the real Public key is decoded from base58 in state.ts)
  const keyBuf = Buffer.alloc(32, 0x42) // 0x42 = 'B' — easily identified
  keyBuf.copy(buf, TREASURY_USDC_OFFSET)
  return buf
}

describe('fetchRebalanceChainState', () => {
  let mockGetAccountInfo: ReturnType<typeof vi.fn>
  let mockGetTokenAccountBalance: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    // Get the mock connection's method stubs
    const connInstances = vi.mocked(Connection).mock.results
    // The mock always returns the same object; reconstruct it via direct access
    const mockConn = {
      getAccountInfo: vi.fn(),
      getTokenAccountBalance: vi.fn(),
    }

    vi.mocked(Connection).mockImplementation(() => mockConn as any)
    mockGetAccountInfo = mockConn.getAccountInfo
    mockGetTokenAccountBalance = mockConn.getTokenAccountBalance

    // Default: token balance = 500 USDC (500_000_000 lamports, 6 decimals)
    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: '500000000', decimals: 6, uiAmount: 500 },
    })
  })

  it('returns rebalance_counter from on-chain RiskVault data', async () => {
    const expectedCounter = 42

    const riskVaultData = buildRiskVaultData(expectedCounter)
    const treasuryData = buildTreasuryData(FAKE_TREASURY_USDC)

    mockGetAccountInfo
      .mockResolvedValueOnce({ data: riskVaultData }) // riskVault
      .mockResolvedValueOnce({ data: treasuryData })  // treasury

    const result = await fetchRebalanceChainState('https://test-rpc.com', 'moderate')

    expect(result.rebalanceCounter).toBe(expectedCounter)
  })

  it('returns treasury USDC address extracted from Treasury account data', async () => {
    const riskVaultData = buildRiskVaultData(7)
    const treasuryData = buildTreasuryData(FAKE_TREASURY_USDC)

    mockGetAccountInfo
      .mockResolvedValueOnce({ data: riskVaultData })
      .mockResolvedValueOnce({ data: treasuryData })

    const result = await fetchRebalanceChainState('https://test-rpc.com', 'aggressive')

    // The treasury USDC address should be a PublicKey whose bytes match
    // what we wrote into the buffer at TREASURY_USDC_OFFSET (all 0x42)
    const bytes = result.treasuryUsdcAddress.toBytes()
    expect(bytes.every(b => b === 0x42)).toBe(true)
  })

  it('returns equity snapshot from vault USDC token account balance', async () => {
    const riskVaultData = buildRiskVaultData(1)
    const treasuryData = buildTreasuryData(FAKE_TREASURY_USDC)

    mockGetAccountInfo
      .mockResolvedValueOnce({ data: riskVaultData })
      .mockResolvedValueOnce({ data: treasuryData })

    mockGetTokenAccountBalance.mockResolvedValue({
      value: { amount: '1234567890', decimals: 6, uiAmount: 1234.56789 },
    })

    const result = await fetchRebalanceChainState('https://test-rpc.com', 'moderate')

    expect(result.equitySnapshot).toBe(1234567890n)
  })

  it('throws descriptive error when RiskVault account not found', async () => {
    mockGetAccountInfo
      .mockResolvedValueOnce(null) // RiskVault missing
      .mockResolvedValueOnce({ data: buildTreasuryData(FAKE_TREASURY_USDC) })

    await expect(
      fetchRebalanceChainState('https://test-rpc.com', 'moderate'),
    ).rejects.toThrow(/RiskVault account not found/)
  })

  it('throws descriptive error when Treasury account not found', async () => {
    mockGetAccountInfo
      .mockResolvedValueOnce({ data: buildRiskVaultData(0) }) // RiskVault ok
      .mockResolvedValueOnce(null)                             // Treasury missing

    await expect(
      fetchRebalanceChainState('https://test-rpc.com', 'moderate'),
    ).rejects.toThrow(/Treasury account not found/)
  })

  it('throws on unknown risk level', async () => {
    await expect(
      fetchRebalanceChainState('https://test-rpc.com', 'ultra-risky'),
    ).rejects.toThrow(/Unknown risk level/)
  })
})

// ─── fetchVaultEquity ────────────────────────────────────────────────────────
// RiskVault equity field offsets (after 8-byte discriminator):
//   disc(8) | version(1) | allocator(32) | risk_level(1) |
//   protocol_vault(32) | share_mint(32) |
//   total_shares(8) | total_assets(8) | peak_equity(8) | current_equity(8)
const TOTAL_ASSETS_OFFSET = 114
const PEAK_EQUITY_OFFSET = 122
const CURRENT_EQUITY_OFFSET = 130

function buildRiskVaultEquity(
  totalAssets: bigint,
  peakEquity: bigint,
  currentEquity: bigint,
): Buffer {
  const buf = Buffer.alloc(256, 0)
  buf.writeBigUInt64LE(totalAssets, TOTAL_ASSETS_OFFSET)
  buf.writeBigUInt64LE(peakEquity, PEAK_EQUITY_OFFSET)
  buf.writeBigUInt64LE(currentEquity, CURRENT_EQUITY_OFFSET)
  return buf
}

describe('fetchVaultEquity', () => {
  let mockGetAccountInfo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    const mockConn = {
      getAccountInfo: vi.fn(),
      getTokenAccountBalance: vi.fn(),
    }
    vi.mocked(Connection).mockImplementation(() => mockConn as any)
    mockGetAccountInfo = mockConn.getAccountInfo
  })

  it('reads total_assets, peak_equity, current_equity from RiskVault bytes', async () => {
    const data = buildRiskVaultEquity(500_000_000n, 600_000_000n, 580_000_000n)
    mockGetAccountInfo.mockResolvedValueOnce({ data })

    const result = await fetchVaultEquity('https://test-rpc.com', 'moderate')

    expect(result.totalAssets).toBe(500_000_000n)
    expect(result.peakEquity).toBe(600_000_000n)
    expect(result.currentEquity).toBe(580_000_000n)
  })

  it('throws when RiskVault account not found', async () => {
    mockGetAccountInfo.mockResolvedValueOnce(null)
    await expect(
      fetchVaultEquity('https://test-rpc.com', 'moderate'),
    ).rejects.toThrow(/RiskVault account not found/)
  })

  it('throws on unknown risk level', async () => {
    await expect(
      fetchVaultEquity('https://test-rpc.com', 'invalid'),
    ).rejects.toThrow(/Unknown risk level/)
  })
})
