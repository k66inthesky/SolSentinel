import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
// Minimal Anchor-compatible wallet (the package's NodeWallet isn't exposed to ESM).
export class KeypairWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) tx.sign([this.payer]); else tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const t of txs) await this.signTransaction(t);
    return txs;
  }
}
