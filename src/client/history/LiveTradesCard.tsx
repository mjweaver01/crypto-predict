// Real-money (or shadow) execution record with on-chain fill verification.
// Hidden entirely until at least one trade exists.

import { useState } from 'preact/hooks';
import type { TradeRecord } from '../../shared/types.ts';
import { COLORS, fmtDateTime, fmtUsd2 } from '../format.ts';
import { liveTrades, verifyFills } from './state.ts';

const POLYGONSCAN = 'https://polygonscan.com/tx/';

function VerifyBadge({ t }: { t: TradeRecord }) {
  if (t.status === 'dry-run') return null;
  if (!t.verifyStatus)
    return (
      <span class="lt-badge lt-badge-none" title="Not yet verified">
        ?
      </span>
    );
  const map = {
    match: ['lt-badge-match', '✓'],
    mismatch: ['lt-badge-mismatch', '⚠'],
    notfound: ['lt-badge-notfound', '?'],
    error: ['lt-badge-error', '✗'],
  } as const;
  const [cls, glyph] = map[t.verifyStatus];
  return (
    <span class={`lt-badge ${cls}`} title={t.verifyNote ?? ''}>
      {glyph}
    </span>
  );
}

function TxLinks({ t }: { t: TradeRecord }) {
  const hashes = [
    ...(t.fillTxHashes ?? []),
    ...(t.redeemTx && t.redeemTx !== 'none' ? [t.redeemTx] : []),
  ];
  return (
    <>
      {hashes.map((h, i) => (
        <a
          key={h}
          class="lt-tx"
          href={`${POLYGONSCAN}${h}`}
          target="_blank"
          rel="noopener"
        >
          {i === 0 ? 'fill' : 'redeem'} ↗
        </a>
      ))}
    </>
  );
}

function LiveTradeRow({ t }: { t: TradeRecord }) {
  const statusCls =
    t.status === 'filled'
      ? 'lt-status-filled'
      : t.status === 'partial'
        ? 'lt-status-partial'
        : t.status === 'dry-run'
          ? 'lt-status-dryrun'
          : 'lt-status-other';
  return (
    <div class="pt-bet lt-row">
      <VerifyBadge t={t} />
      <span class={`lt-status ${statusCls}`}>{t.status}</span>
      <span class="rec-range">{t.rangeId}</span>
      <span class="pt-when">{fmtDateTime(t.placedAt)}</span>
      <span class={`rec-side ${t.side === 'UP' ? 'up' : 'down'}`}>
        {t.side}
      </span>
      <span class="pt-num">at {(t.quotedCost * 100).toFixed(1)}¢</span>
      <span class="pt-num">bet {fmtUsd2(t.costUsd ?? t.intendedUsd)}</span>
      {t.pnlUsd !== undefined ? (
        <span class={`pt-pnl ${t.pnlUsd >= 0 ? 'up' : 'down'}`}>
          {t.pnlUsd >= 0 ? '+' : ''}
          {fmtUsd2(t.pnlUsd)}
        </span>
      ) : t.shares !== undefined && t.costUsd !== undefined ? (
        <span class="pt-pnl">
          to win {fmtUsd2((t.shares * (1 - t.quotedCost)) / t.quotedCost)}
        </span>
      ) : null}
      <TxLinks t={t} />
      {(t.verifyStatus === 'match' || t.verifyStatus === 'mismatch') && (
        <span class="lt-verified-detail">{t.verifyNote}</span>
      )}
    </div>
  );
}

export function LiveTradesCard() {
  const trades = liveTrades.value;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(
    null
  );

  if (trades.length === 0) return null;

  const settled = trades.filter(t => t.settledAt);
  const wins = settled.filter(t => t.won).length;
  const pnl = settled.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const isDryRun = trades.every(t => t.status === 'dry-run');
  const verifiedMatch = trades.filter(t => t.verifyStatus === 'match').length;
  const verifiable = trades.filter(
    t => t.status === 'filled' || t.status === 'partial'
  ).length;

  const onVerify = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const c = await verifyFills();
      setStatus({
        text:
          `✓ ${c.match} · ⚠ ${c.mismatch} · ? ${c.notfound}` +
          (c.error ? ` · ✗ ${c.error}` : ''),
        ok: true,
      });
    } catch (err) {
      setStatus({ text: `Error: ${err}`, ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="card hr-card">
      <div class="hr-top">
        <div>
          <span class="card-title">
            <span>Live trades · execution record</span>
          </span>
          <div class="record-sub">
            {`${trades.length} trade${trades.length !== 1 ? 's' : ''}`}
            {isDryRun ? ' · shadow mode' : ''}
            {` · ${settled.length} settled (${wins}W–${settled.length - wins}L)`}
          </div>
        </div>
        <div class="record-stats">
          <div>
            <div class="rstat-label">P&amp;L</div>
            <div
              class="rstat-val"
              style={{ color: pnl >= 0 ? COLORS.up : COLORS.down }}
            >
              {pnl >= 0 ? '+' : ''}
              {fmtUsd2(pnl)}
            </div>
          </div>
          <div>
            <div class="rstat-label">Staked</div>
            <div class="rstat-val">
              {fmtUsd2(settled.reduce((s, t) => s + (t.costUsd ?? 0), 0))}
            </div>
          </div>
          <div>
            <div class="rstat-label">Verified</div>
            <div class="rstat-val">
              {verifiedMatch} / {verifiable}
            </div>
          </div>
        </div>
      </div>
      <div class="lt-actions">
        <button class="lt-verify-btn" disabled={busy} onClick={onVerify}>
          {busy ? 'Verifying…' : 'Verify fills'}
        </button>
        {status && (
          <span
            class={`lt-verify-status ${status.ok ? 'lt-verify-done' : 'lt-verify-err'}`}
          >
            {status.text}
          </span>
        )}
      </div>
      <div class="lt-trades">
        {trades.map(t => (
          <LiveTradeRow key={t.id} t={t} />
        ))}
      </div>
    </div>
  );
}
