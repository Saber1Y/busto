import { z } from "zod";

// x402-aligned PaymentIntent (PRD §10). The agentic payment object. The recipient
// (`to`) is ALWAYS the vendor's DB known_wallet — never the document's wallet.
export interface PaymentIntent {
  to: string; // EIP-55 recipient = DB known_wallet
  amount: string; // integer minor units (bigint as string for JSON)
  token: string; // pinned ERC-20 token address
  chainId: number; // pinned chain id
  invoiceRef: string;
  memo: string;
}

export const paymentIntentSchema = z.object({
  to: z.string(),
  amount: z.string(),
  token: z.string(),
  chainId: z.number(),
  invoiceRef: z.string(),
  memo: z.string(),
});

/** Build the intent from a PASS verdict. Recipient = knownWallet (DB), not the invoice. */
export function buildPaymentIntent(opts: {
  knownWallet: string;
  amountMinor: bigint;
  token: string;
  chainId: number;
  invoiceRef: string;
  memo: string;
}): PaymentIntent {
  return {
    to: opts.knownWallet,
    amount: opts.amountMinor.toString(),
    token: opts.token,
    chainId: opts.chainId,
    invoiceRef: opts.invoiceRef,
    memo: opts.memo,
  };
}
