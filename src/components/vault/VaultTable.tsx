'use client';

import { chainName } from '@/lib/chains';
import { formatCompactUsd, formatPercent, formatUsd, shortAddress } from '@/lib/format';
import type { MorphoVault } from '@/lib/providers/vault-types';
import './vault.css';

interface VaultTableProps {
  readonly title: string;
  readonly vaults: readonly MorphoVault[];
}

/**
 * Deposit targets, as a table. Ordered by net APY, which is the number the
 * user is choosing between — the curator column sits next to it because that
 * choice is where the risk actually lives.
 */
export function VaultTable({ title, vaults }: VaultTableProps) {
  if (vaults.length === 0) return null;

  const showsProjection = vaults.some((v) => v.projectedYearlyUsd !== undefined);

  return (
    <section className="vault-panel" aria-label={title}>
      <header className="vault-head">
        <h3>{title}</h3>
        <span className="vault-source">Morpho · live</span>
      </header>

      <div className="vault-scroll">
        <table className="vault-table">
          <thead>
            <tr>
              <th scope="col">Vault</th>
              <th scope="col">Curator</th>
              <th scope="col" className="col-num">Net APY</th>
              <th scope="col" className="col-num">Size</th>
              {showsProjection && <th scope="col" className="col-num">Est. / yr</th>}
            </tr>
          </thead>
          <tbody>
            {vaults.map((vault) => (
              <tr key={`${vault.chainId}-${vault.address}`}>
                <th scope="row">
                  <span className="vault-name">{vault.name}</span>
                  <span className="vault-meta">
                    {vault.asset.symbol} · {chainName(vault.chainId)} ·{' '}
                    <span className="num">{shortAddress(vault.address)}</span>
                  </span>
                </th>

                <td>
                  <span className="vault-curator">{vault.curator ?? 'Unknown'}</span>
                  {vault.isVetted && <span className="tag tag--vetted">Vetted</span>}
                </td>

                <td className="col-num num apy">{formatPercent(vault.netApy)}</td>
                <td className="col-num num size">{formatCompactUsd(vault.totalAssetsUsd)}</td>

                {showsProjection && (
                  <td className="col-num num projection">
                    {vault.projectedYearlyUsd !== undefined
                      ? formatUsd(vault.projectedYearlyUsd)
                      : '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="vault-foot">
        A vault lends into markets its curator selects — that selection is the
        risk you take, not the vault wrapper. APY is variable and can fall at any
        time. Ask to deposit and you&rsquo;ll get a transaction to review.
      </footer>
    </section>
  );
}
