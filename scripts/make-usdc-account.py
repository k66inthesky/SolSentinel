"""Writes a solana-test-validator --account JSON for a USDC token account holding `amount` (fork testing only:
mainnet USDC cannot be minted locally, so the owner's starting balance is injected into the forked ledger)."""
import base64, json, struct, sys, hashlib
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n = 0
    for ch in s: n = n * 58 + B58.index(ch)
    b = n.to_bytes(32, "big"); return b
addr, mint, owner, amount, out = sys.argv[1:6]
data = b58d(mint) + b58d(owner) + struct.pack("<Q", int(amount)) + b"\0" * 36 + b"\x01" + b"\0" * 12 + b"\0" * 8 + b"\0" * 36
assert len(data) == 165
json.dump({"pubkey": addr, "account": {"lamports": 2039280, "data": [base64.b64encode(data).decode(), "base64"],
           "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "executable": False, "rentEpoch": 18446744073709551615, "space": 165}}, open(out, "w"))
