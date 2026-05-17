import {
  AssetType,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

export type ClobTraderOptions = {
  host: string;
  chainId: number;
  privateKey: Hex;
  funderAddress?: string;
  signatureType: number;
  dryRun: boolean;
  slippageCents: number;
  rpcUrl?: string;
};

export type BuyResult = {
  ok: boolean;
  orderId?: string;
  status?: string;
  error?: string;
  dryRun?: boolean;
};

function mapSignatureType(n: number): SignatureTypeV2 {
  switch (n) {
    case 0:
      return SignatureTypeV2.EOA;
    case 1:
      return SignatureTypeV2.POLY_PROXY;
    case 2:
      return SignatureTypeV2.POLY_GNOSIS_SAFE;
    case 3:
      return SignatureTypeV2.POLY_1271;
    default:
      return SignatureTypeV2.POLY_PROXY;
  }
}

export class ClobTrader {
  private client: ClobClient | null = null;

  constructor(private readonly opts: ClobTraderOptions) {}

  async init(): Promise<void> {
    const account = privateKeyToAccount(this.opts.privateKey);
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(this.opts.rpcUrl || "https://polygon-rpc.com"),
    });

    const temp = new ClobClient({
      host: this.opts.host,
      chain: this.opts.chainId,
      signer,
    });
    const creds = await temp.createOrDeriveApiKey();

    const funder = this.opts.funderAddress?.trim() as Address | undefined;
    this.client = new ClobClient({
      host: this.opts.host,
      chain: this.opts.chainId,
      signer,
      creds,
      signatureType: mapSignatureType(this.opts.signatureType),
      funderAddress: funder,
    });

    await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async buyFok(tokenId: string, priceCents: number, size: number, negRiskFallback: boolean): Promise<BuyResult> {
    const slip = Math.max(0, this.opts.slippageCents);
    const limitPx = Math.min(0.99, (priceCents + slip) / 100);

    if (this.opts.dryRun) {
      return {
        ok: true,
        dryRun: true,
        orderId: "dry-run",
        status: `would BUY ${size} @ ${(limitPx * 100).toFixed(0)}c max`,
      };
    }

    const client = this.client;
    if (!client) return { ok: false, error: "clob client not initialized" };

    let tickSize: TickSize = "0.01";
    let negRisk = negRiskFallback;
    try {
      tickSize = (await client.getTickSize(tokenId)) as TickSize;
      negRisk = await client.getNegRisk(tokenId);
    } catch {
      /* use defaults */
    }

    try {
      // FOK must use market order API; BUY amount is USDC notional.
      const amountUsd = size * limitPx;
      const response = await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          price: limitPx,
          amount: amountUsd,
          side: Side.BUY,
          orderType: OrderType.FOK,
        },
        { tickSize, negRisk },
        OrderType.FOK
      );
      const orderId = String((response as { orderID?: string }).orderID ?? "");
      const status = String((response as { status?: string }).status ?? "unknown");
      const ok = status.toLowerCase() !== "rejected" && status.toLowerCase() !== "failed";
      return { ok, orderId, status, error: ok ? undefined : `order status=${status}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
}

export function parsePrivateKey(raw: string): Hex | null {
  const v = raw.trim();
  if (!v) return null;
  const hex = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
  return hex as Hex;
}
