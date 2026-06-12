import { render } from 'preact';
import { LivePage } from './live/LivePage.tsx';
import { startLive } from './live/state.ts';

render(<LivePage />, document.getElementById('app')!);
startLive();
