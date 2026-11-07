#!/usr/bin/env bash
# Local validator forked from mainnet: real Jupiter Lend Earn + Liquidity programs and their USDC accounts
# are cloned, so the vault's rebalance CPI runs against the exact production code.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=${MAINNET_RPC:-https://api.mainnet-beta.solana.com}
OWNER=$(solana address -k ~/.config/solana/id.json)
OWNER_USDC=$(NODE_NO_WARNINGS=1 node -e "const {getAssociatedTokenAddressSync}=require(\"@solana/spl-token\");const {PublicKey}=require(\"@solana/web3.js\");console.log(getAssociatedTokenAddressSync(new PublicKey(\"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\"),new PublicKey(process.argv[1])).toBase58())" "$OWNER")
mkdir -p .fork && python3 scripts/make-usdc-account.py "$OWNER_USDC" EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v "$OWNER" 10000000 .fork/owner-usdc.json
ACCTS=(So11111111111111111111111111111111111111112 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59 Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6 B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D 3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D
  5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6 2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ 94vK29npVbyRHXH63rRcTiSr26SFhrQTzbpNJuhQEDu
  Hf9gtkM4dpVBahVSzEXSVCAPpKzBsBcns3s8As3z77oF 5pjzT5dFTsXcwixoab1QDLvZQvpYJxJeBphkyfHGn688 BmkUoKMFYBxNSzWXyUjyMJjMAaVz4d8ZnxwwmhDCUXFB
  7s1da8DduuBFqGra5bJBjpnvL5E9mGzCuMk1Qkh4or2Z 5xSPBiD3TibamAnwHDhZABdB4z4F9dcj5PnbteroBTTd HN1r4VfkDn53xQQfeGDYrNuDKFdemAhZsHYRwBrFhsW)
ARGS=(); for a in "${ACCTS[@]}" ${EXTRA_CLONE:-}; do ARGS+=(--clone "$a"); done
for p in jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9 jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD ${EXTRA_PROGRAMS:-}; do ARGS+=(--clone-upgradeable-program "$p"); done
exec solana-test-validator --ledger .fork/ledger --url "$RPC" "${ARGS[@]}" \
  --account "$OWNER_USDC" .fork/owner-usdc.json \
  --bpf-program 6TL13uSNzjJhG48LheLAZJei4M62rEe4peaj9GASECKu target/deploy/sentinel_vault.so \
  --bpf-program HGsqvWLXJHuQnVdhvd2aXYRYhziHVEJsi8bacLg6bomo target/deploy/mock_swap.so --quiet
