import { useState } from 'react';
import { WINDOW_NOTE_IDS, WINDOW_NOTE_LABELS, type PlacementEvaluation, type PlacementReceipt, type WindowNoteId } from '../../shared/domain';
import { postBattleReport, shareReport } from '../lib/lot';

export interface ShiftOutcome {
  readonly mode: 'OFFICIAL_LIVE' | 'VISITOR_HOLD' | 'PRACTICE_SNAPSHOT';
  readonly floorNumber: number;
  readonly metrics: PlacementEvaluation | PlacementReceipt;
  readonly summary: string;
  readonly streak: number;
  readonly username: string;
}

interface ShiftResultProps {
  readonly outcome: ShiftOutcome;
  readonly onSignIn: () => void;
  readonly onPractice: () => void;
}

export function ShiftResult({ outcome, onSignIn, onPractice }: ShiftResultProps): React.JSX.Element {
  const { mode, floorNumber, metrics, username, streak, summary } = outcome;
  const [noteId, setNoteId] = useState<WindowNoteId | null>(null);
  const [feedback, setFeedback] = useState('');
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [copyableReport, setCopyableReport] = useState<string | null>(null);
  const official = mode === 'OFFICIAL_LIVE';
  const report = `Last Spot · B${floorNumber} · ${metrics.wastedStalls} wasted stalls · Elevator Bonus +${metrics.elevatorBonus} · Streak ${streak} · ${mode}${noteId ? ` · ${WINDOW_NOTE_LABELS[noteId]}` : ''}`;

  async function post(): Promise<void> {
    setPosting(true);
    try {
      const result = await postBattleReport(noteId);
      if (!result.ok) {
        setFeedback('Could not post the Battle Report. You can still share or copy it.');
      } else if (result.posted || result.alreadyShared) {
        setPosted(true);
        setFeedback(result.alreadyShared ? 'Battle Report already posted.' : 'Battle Report posted.');
      } else {
        setCopyableReport(result.formattedReport);
        setFeedback('Could not post the Battle Report. Use Share or Copy.');
      }
    } catch {
      setFeedback('Could not post the Battle Report. You can still share or copy it.');
    } finally {
      setPosting(false);
    }
  }

  return (
    <section className="shift-result" aria-labelledby="result-title">
      <p className="wayfinding"><strong>B{floorNumber}</strong> {mode}</p>
      <h2 id="result-title">{'crownedLastSpotHero' in metrics && metrics.crownedLastSpotHero ? 'Last Spot Hero' : 'Shift complete'}</h2>
      <p className="result-metrics">{metrics.wastedStalls} wasted stalls · Elevator Bonus +{metrics.elevatorBonus}</p>
      <p>Streak {streak} · {summary}</p>
      <h3>Battle Report preview</h3>
      {official && <label className="window-note">Window note
        <select value={noteId ?? ''} disabled={posting || posted} onChange={(event) => {
          setNoteId(WINDOW_NOTE_IDS.find((id) => id === event.currentTarget.value) ?? null);
          setCopyableReport(null);
        }}>
          <option value="">No window note</option>
          {WINDOW_NOTE_IDS.map((id) => <option key={id} value={id}>{WINDOW_NOTE_LABELS[id]}</option>)}
        </select>
      </label>}
      <p className="report-preview">{copyableReport ?? report}</p>
      {official && <p>During playtesting, the app account may post on your behalf and credit u/{username}.</p>}
      <div className="result-actions">
        {official && <button className="action" type="button" disabled={posting || posted} onClick={() => { void post(); }}>Post Battle Report</button>}
        {mode === 'VISITOR_HOLD' && <button className="action" type="button" onClick={onSignIn}>Sign in to Lock Spot</button>}
        <button className="action secondary" type="button" onClick={() => { void shareReport(copyableReport ?? report).then(setFeedback); }}>Share or Copy</button>
        <button className="action secondary" type="button" onClick={onPractice}>Practice Again</button>
      </div>
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
