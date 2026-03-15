import type { DriftClient } from '@drift-labs/sdk'
import { PositionDirection, OrderType, MarketType, BASE_PRECISION } from '@drift-labs/sdk'
import { BN } from '@coral-xyz/anchor'

export interface TradeParams {
  marketIndex: number
  direction: 'long' | 'short'
  sizeUsd: number
}

export async function openPerpPosition(
  dc: DriftClient,
  params: TradeParams,
): Promise<string> {
  const direction = params.direction === 'long'
    ? PositionDirection.LONG
    : PositionDirection.SHORT

  const orderParams = {
    direction,
    baseAssetAmount: new BN(params.sizeUsd).mul(BASE_PRECISION),
    marketIndex: params.marketIndex,
    marketType: MarketType.PERP,
    orderType: OrderType.MARKET,
  }

  const txSig = await dc.placeAndTakePerpOrder(orderParams)
  return txSig
}

export async function closePerpPosition(
  dc: DriftClient,
  marketIndex: number,
): Promise<string> {
  const user = dc.getUser()
  const position = user.getPerpPosition(marketIndex)
  if (!position || position.baseAssetAmount.isZero()) {
    return '' // No position to close
  }

  const direction = position.baseAssetAmount.gt(new BN(0))
    ? PositionDirection.SHORT // Close long by shorting
    : PositionDirection.LONG  // Close short by longing

  const orderParams = {
    direction,
    baseAssetAmount: position.baseAssetAmount.abs(),
    marketIndex,
    marketType: MarketType.PERP,
    orderType: OrderType.MARKET,
  }

  const txSig = await dc.placeAndTakePerpOrder(orderParams)
  return txSig
}
