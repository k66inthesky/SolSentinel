#!/usr/bin/env bash
# Local validator with both programs preloaded at their declared ids.
cd "$(dirname "$0")/.."
exec solana-test-validator --reset --quiet --ledger .ledger \
  --bpf-program 6TL13uSNzjJhG48LheLAZJei4M62rEe4peaj9GASECKu target/deploy/sentinel_vault.so \
  --bpf-program HGsqvWLXJHuQnVdhvd2aXYRYhziHVEJsi8bacLg6bomo target/deploy/mock_swap.so
