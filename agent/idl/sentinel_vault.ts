/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sentinel_vault.json`.
 */
export type SentinelVault = {
  "address": "6TL13uSNzjJhG48LheLAZJei4M62rEe4peaj9GASECKu",
  "metadata": {
    "name": "sentinelVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "initYield",
      "docs": [
        "Owner whitelists up to 4 lending venues: (lending program, receipt-token mint)."
      ],
      "discriminator": [
        19,
        1,
        6,
        165,
        207,
        249,
        41,
        255
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "yieldConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  105,
                  101,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "venues",
          "type": {
            "vec": {
              "defined": {
                "name": "venue"
              }
            }
          }
        },
        {
          "name": "maxMovesPerDay",
          "type": "u16"
        },
        {
          "name": "minMoveIntervalSecs",
          "type": "u32"
        }
      ]
    },
    {
      "name": "initializeVault",
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "quoteMint"
        },
        {
          "name": "baseMint"
        },
        {
          "name": "vaultQuote",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultBase",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "swapProgram",
          "type": "pubkey"
        },
        {
          "name": "policy",
          "type": {
            "defined": {
              "name": "policy"
            }
          }
        }
      ]
    },
    {
      "name": "logDecision",
      "docs": [
        "Append an AI decision to the on-chain audit log. `reason_hash` = sha256 of the full",
        "LLM/strategy reasoning JSON that the agent stores off-chain; anyone can re-hash and verify."
      ],
      "discriminator": [
        160,
        73,
        104,
        176,
        37,
        115,
        231,
        204
      ],
      "accounts": [
        {
          "name": "agent",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "regime",
          "type": "u8"
        },
        {
          "name": "action",
          "type": "u8"
        },
        {
          "name": "priceE6",
          "type": "u64"
        },
        {
          "name": "reasonHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "rebalance",
      "docs": [
        "Guarded move of USDC into (Deposit) or out of (Withdraw) a whitelisted lending venue.",
        "The agent supplies the CPI bytes, but the program enforces:",
        "- the target program is the venue's whitelisted lending program,",
        "- tokens can only move between the vault's USDC account and the vault's receipt-token",
        "account for that venue (both PDA-owned ATAs, so nothing can leave the vault),",
        "- measured balance deltas respect max_in / min_out (agent cannot lie about amounts),",
        "- a rate limit (moves per day + minimum interval) so a compromised agent cannot churn fees,",
        "- deposits are blocked while paused; withdrawals back to USDC are always allowed."
      ],
      "discriminator": [
        108,
        158,
        77,
        9,
        210,
        52,
        88,
        62
      ],
      "accounts": [
        {
          "name": "agent",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "relations": [
            "yieldConfig"
          ]
        },
        {
          "name": "yieldConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  105,
                  101,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultQuote",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "vault.quoteMint",
                "account": "vault"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultReceipt",
          "docs": [
            "Receipt-token account; must be owned by the vault, mint checked against the venue."
          ],
          "writable": true
        },
        {
          "name": "lendingProgram"
        }
      ],
      "args": [
        {
          "name": "venue",
          "type": "u8"
        },
        {
          "name": "direction",
          "type": {
            "defined": {
              "name": "direction"
            }
          }
        },
        {
          "name": "maxIn",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        },
        {
          "name": "cpiData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "setAgent",
      "discriminator": [
        154,
        74,
        121,
        91,
        137,
        19,
        101,
        166
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPaused",
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setPolicy",
      "discriminator": [
        40,
        133,
        12,
        157,
        235,
        202,
        2,
        132
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "policy",
          "type": {
            "defined": {
              "name": "policy"
            }
          }
        }
      ]
    },
    {
      "name": "setYield",
      "discriminator": [
        234,
        85,
        157,
        135,
        75,
        39,
        160,
        170
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          },
          "relations": [
            "yieldConfig"
          ]
        },
        {
          "name": "yieldConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  105,
                  101,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "venues",
          "type": {
            "vec": {
              "defined": {
                "name": "venue"
              }
            }
          }
        },
        {
          "name": "maxMovesPerDay",
          "type": "u16"
        },
        {
          "name": "minMoveIntervalSecs",
          "type": "u32"
        }
      ]
    },
    {
      "name": "swap",
      "docs": [
        "Guarded swap. `cpi_data` and `remaining_accounts` are passed verbatim to the whitelisted",
        "swap program; the vault PDA signs. The program trusts nothing the agent claims about",
        "amounts: it reads token balances before and after the CPI."
      ],
      "discriminator": [
        248,
        198,
        158,
        145,
        225,
        117,
        135,
        200
      ],
      "accounts": [
        {
          "name": "agent",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "vaultQuote",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "vault.quoteMint",
                "account": "vault"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultBase",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "vault.baseMint",
                "account": "vault"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "swapProgram"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": {
            "defined": {
              "name": "side"
            }
          }
        },
        {
          "name": "maxIn",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        },
        {
          "name": "cpiData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Owner-only withdrawal. The agent key has no path to move funds out of the vault."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "from",
          "writable": true
        },
        {
          "name": "to",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    },
    {
      "name": "yieldConfig",
      "discriminator": [
        249,
        13,
        186,
        63,
        85,
        7,
        255,
        18
      ]
    }
  ],
  "events": [
    {
      "name": "dailyLossHaltTriggered",
      "discriminator": [
        9,
        147,
        176,
        61,
        209,
        168,
        113,
        223
      ]
    },
    {
      "name": "decisionLogged",
      "discriminator": [
        230,
        225,
        27,
        62,
        90,
        190,
        89,
        146
      ]
    },
    {
      "name": "pauseChanged",
      "discriminator": [
        238,
        188,
        213,
        78,
        134,
        209,
        178,
        218
      ]
    },
    {
      "name": "policyUpdated",
      "discriminator": [
        225,
        112,
        112,
        67,
        95,
        236,
        245,
        161
      ]
    },
    {
      "name": "rebalanced",
      "discriminator": [
        74,
        101,
        57,
        244,
        181,
        179,
        52,
        182
      ]
    },
    {
      "name": "tradeExecuted",
      "discriminator": [
        41,
        110,
        64,
        129,
        60,
        79,
        179,
        80
      ]
    },
    {
      "name": "vaultInitialized",
      "discriminator": [
        180,
        43,
        207,
        2,
        18,
        71,
        3,
        75
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "Vault is paused by its owner"
    },
    {
      "code": 6001,
      "name": "dailyLossHalt",
      "msg": "Daily loss limit hit; new buys halted until next UTC day"
    },
    {
      "code": 6002,
      "name": "tradeTooLarge",
      "msg": "Trade exceeds per-trade cap"
    },
    {
      "code": 6003,
      "name": "tooManyTrades",
      "msg": "Daily trade count reached"
    },
    {
      "code": 6004,
      "name": "cooldown",
      "msg": "Cooldown between trades not elapsed"
    },
    {
      "code": 6005,
      "name": "swapProgramNotAllowed",
      "msg": "Swap program is not the whitelisted one"
    },
    {
      "code": 6006,
      "name": "insufficientFunds",
      "msg": "Vault balance too low"
    },
    {
      "code": 6007,
      "name": "balanceMismatch",
      "msg": "Token balance moved the wrong way"
    },
    {
      "code": 6008,
      "name": "overSpent",
      "msg": "Swap spent more than max_in"
    },
    {
      "code": 6009,
      "name": "slippage",
      "msg": "Received less than min_out"
    },
    {
      "code": 6010,
      "name": "mintNotAllowed",
      "msg": "Mint not allowed"
    },
    {
      "code": 6011,
      "name": "badPolicy",
      "msg": "Invalid policy"
    }
  ],
  "types": [
    {
      "name": "dailyLossHaltTriggered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "day",
            "type": "i64"
          },
          {
            "name": "realizedPnlToday",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "decisionLogged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u64"
          },
          {
            "name": "regime",
            "type": "u8"
          },
          {
            "name": "action",
            "type": "u8"
          },
          {
            "name": "priceE6",
            "type": "u64"
          },
          {
            "name": "reasonHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "direction",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "deposit"
          },
          {
            "name": "withdraw"
          }
        ]
      }
    },
    {
      "name": "pauseChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "policy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxTradeQuote",
            "docs": [
              "Max quote (USDC base units) per buy."
            ],
            "type": "u64"
          },
          {
            "name": "maxTradesPerDay",
            "type": "u16"
          },
          {
            "name": "dailyLossLimitQuote",
            "docs": [
              "Realized loss (USDC base units) per UTC day that halts new buys."
            ],
            "type": "u64"
          },
          {
            "name": "cooldownSecs",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "policyUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "policy",
            "type": {
              "defined": {
                "name": "policy"
              }
            }
          }
        ]
      }
    },
    {
      "name": "rebalanced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "venue",
            "type": "u8"
          },
          {
            "name": "direction",
            "type": {
              "defined": {
                "name": "direction"
              }
            }
          },
          {
            "name": "spent",
            "type": "u64"
          },
          {
            "name": "received",
            "type": "u64"
          },
          {
            "name": "decisionSeq",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "side",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "buy"
          },
          {
            "name": "sell"
          }
        ]
      }
    },
    {
      "name": "tradeExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "spent",
            "type": "u64"
          },
          {
            "name": "received",
            "type": "u64"
          },
          {
            "name": "realizedPnl",
            "type": "i64"
          },
          {
            "name": "realizedPnlToday",
            "type": "i64"
          },
          {
            "name": "decisionSeq",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "swapProgram",
            "type": "pubkey"
          },
          {
            "name": "policy",
            "type": {
              "defined": {
                "name": "policy"
              }
            }
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "day",
            "type": "i64"
          },
          {
            "name": "haltedDay",
            "type": "i64"
          },
          {
            "name": "tradesToday",
            "type": "u16"
          },
          {
            "name": "realizedPnlToday",
            "type": "i64"
          },
          {
            "name": "lastTradeTs",
            "type": "i64"
          },
          {
            "name": "openCost",
            "type": "u64"
          },
          {
            "name": "totalTrades",
            "type": "u64"
          },
          {
            "name": "totalRealizedPnl",
            "type": "i64"
          },
          {
            "name": "decisions",
            "type": "u64"
          },
          {
            "name": "lastDecisionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "vaultInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "swapProgram",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "venue",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "program",
            "docs": [
              "Lending program the vault may CPI into (e.g. Jupiter Lend Earn, Kamino Lend)."
            ],
            "type": "pubkey"
          },
          {
            "name": "receiptMint",
            "docs": [
              "Receipt token that program mints for USDC deposits (e.g. jlUSDC, Kamino USDC cToken)."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "yieldConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "venues",
            "type": {
              "vec": {
                "defined": {
                  "name": "venue"
                }
              }
            }
          },
          {
            "name": "maxMovesPerDay",
            "type": "u16"
          },
          {
            "name": "minMoveIntervalSecs",
            "type": "u32"
          },
          {
            "name": "day",
            "type": "i64"
          },
          {
            "name": "movesToday",
            "type": "u16"
          },
          {
            "name": "lastMoveTs",
            "type": "i64"
          },
          {
            "name": "totalMoves",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
