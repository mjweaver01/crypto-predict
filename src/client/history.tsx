import { render } from 'preact';
import { HistoryPage } from './history/HistoryPage.tsx';
import { startHistory } from './history/state.ts';

render(<HistoryPage />, document.getElementById('app')!);
startHistory();
