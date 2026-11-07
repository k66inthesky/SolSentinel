#!/usr/bin/env bash
cd "$(dirname "$0")/.."; export PATH=$HOME/solana-dl/solana-release/bin:$PATH
pkill -f solana-test-validator; sleep 2
nohup scripts/fork-validator.sh > .fork.log 2>&1 < /dev/null & disown
for i in $(seq 1 60); do solana -u l cluster-version >/dev/null 2>&1 && solana -u l account jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9 >/dev/null 2>&1 && exit 0; sleep 2; done; echo "fork validator failed"; tail .fork.log; exit 1
