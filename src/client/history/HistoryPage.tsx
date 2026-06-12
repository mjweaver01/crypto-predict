// The history page, composed: hit rate, learning curve, paper scoreboard, live
// trades, and the call-history / previous-reads grid.

import { Header } from '../components/Header.tsx';
import { loading, updatedAt } from './state.ts';
import { DateRangeBar } from './DateRangeBar.tsx';
import { HitRateCard } from './HitRateCard.tsx';
import { LearningCurveCard } from './LearningCurveCard.tsx';
import { PaperCard } from './PaperCard.tsx';
import { LiveTradesCard } from './LiveTradesCard.tsx';
import { RecordList } from './RecordList.tsx';
import { PreviousReads } from './PreviousReads.tsx';

export function HistoryPage() {
  return (
    <main class={`app${loading.value ? ' loading' : ''}`}>
      <Header page="history" updated={updatedAt.value}>
        <DateRangeBar />
      </Header>
      <HitRateCard />
      <LearningCurveCard />
      <PaperCard />
      <LiveTradesCard />
      <div class="history-grid">
        <RecordList />
        <PreviousReads />
      </div>
      <div></div>
    </main>
  );
}
