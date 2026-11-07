"""Strategy research lab. Honest-by-construction rules:
 - signal uses data up to the close of bar t; position takes effect from bar t+1 (no lookahead)
 - every position change pays FEE_BPS per side + FIXED_USD per transaction on TRADE_USD notional
 - data split by time: train 60% / validation 20% / test 20%; test is only touched by final.py
"""
import numpy as np

FEE_BPS = 5.0        # price impact + slippage per side (measured Jupiter round trip ~0-1 bps; 5 is conservative)
FIXED_USD = 0.002    # base fee + priority fee per tx (~20k lamports at $90/SOL is $0.0018)
TRADE_USD = 10.0

def load(sym):
    a = np.load(f"/root/research/{sym}_1m.npy")
    return a

def resample(a, k):
    n = len(a) // k * k
    a = a[:n].reshape(-1, k, a.shape[1])
    t = a[:, 0, 0]; o = a[:, 0, 1]; h = a[:, :, 2].max(1); l = a[:, :, 3].min(1); c = a[:, -1, 4]; v = a[:, :, 5].sum(1)
    return dict(t=t, o=o, h=h, l=l, c=c, v=v)

def splits(n):
    return slice(0, int(n * .6)), slice(int(n * .6), int(n * .8)), slice(int(n * .8), n)

def ema(x, n):
    import pandas as pd
    return pd.Series(x).ewm(span=n, adjust=False).mean().to_numpy()

def roll_max(x, n):
    from numpy.lib.stride_tricks import sliding_window_view
    out = np.full_like(x, np.nan); out[n - 1:] = sliding_window_view(x, n).max(1); return out

def roll_min(x, n):
    from numpy.lib.stride_tricks import sliding_window_view
    out = np.full_like(x, np.nan); out[n - 1:] = sliding_window_view(x, n).min(1); return out

def sma(x, n):
    c = np.cumsum(np.insert(x, 0, 0)); out = np.full_like(x, np.nan); out[n - 1:] = (c[n:] - c[:-n]) / n; return out

def rsi(c, n):
    d = np.diff(c, prepend=c[0]); up = np.where(d > 0, d, 0); dn = np.where(d < 0, -d, 0)
    au = ema(up, 2 * n - 1); ad = ema(dn, 2 * n - 1)
    return 100 - 100 / (1 + au / np.maximum(ad, 1e-12))

def evaluate(c, pos, t, sl=None, fee_bps=FEE_BPS, fixed=FIXED_USD, size=TRADE_USD):
    """pos[i] = desired holding decided at close i (0/1). Returns stats over slice sl."""
    if sl is not None:
        c, pos, t = c[sl], pos[sl], t[sl]
    held = np.concatenate([[0.0], pos[:-1]])            # held during bar i = decision at i-1
    r = np.concatenate([[0.0], np.diff(c) / c[:-1]])
    gross = held * r
    changes = np.abs(np.diff(np.concatenate([[0.0], held])))
    cost = changes * (fee_bps / 1e4 + fixed / size)
    net = gross - cost
    eq = np.cumprod(1 + net)
    days = (t[-1] - t[0]) / 86_400_000
    day_idx = ((t - t[0]) // 86_400_000).astype(int)
    daily = np.bincount(day_idx, weights=np.log1p(net))
    sharpe = daily.mean() / (daily.std() + 1e-12) * np.sqrt(365) if len(daily) > 2 else 0
    peak = np.maximum.accumulate(eq)
    trades = int(changes.sum() / 2)
    return dict(ret=eq[-1] - 1, sharpe=sharpe, mdd=float((1 - eq / peak).max()), trades=trades,
                exposure=float(held.mean()), days=days, bh=c[-1] / c[0] - 1,
                cost_share=float(cost.sum()))
