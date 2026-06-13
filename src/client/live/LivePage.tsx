// The live dashboard, composed. The crypto selector drives single-asset vs All
// view; signals keep everything reactive so only changed nodes repaint.

import { Header } from '../components/Header.tsx';
import { selectedCrypto } from '../crypto.ts';
import { errorMsg, loading, liveTrading, updatedAt } from './state.ts';
import { PriceCard } from './PriceCard.tsx';
import { NarrativeCard } from './NarrativeCard.tsx';
import { RangeTabs } from './RangeTabs.tsx';
import { DetailPanel } from './DetailPanel.tsx';
import { AllPanel } from './AllPanel.tsx';
import { TotalsCard } from './TotalsCard.tsx';

export function LivePage() {
  const all = selectedCrypto.value === 'all';
  return (
    <main class={`app${loading.value ? ' loading' : ''}`}>
      <Header
        page="live"
        updated={updatedAt.value}
        liveTrading={liveTrading.value}
      />
      <div class="hero-row">
        <PriceCard />
        {!all && <NarrativeCard />}
      </div>
      {all && <TotalsCard />}
      <RangeTabs />
      {all ? <AllPanel /> : <DetailPanel />}
      <div>{errorMsg.value}</div>
    </main>
  );
}
