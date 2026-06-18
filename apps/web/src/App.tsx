import { VoiceSession } from './VoiceSession';
import { BUILD_ID, downloadDiagLog } from './diagnostics';

/**
 * The entire First Thread voice surface is gated behind `first_thread_voice`
 * (VITE_FIRST_THREAD_VOICE), off by default. With the flag off we render a
 * quiet notice and mount nothing voice-related.
 */
const FLAG_ON = import.meta.env.VITE_FIRST_THREAD_VOICE === 'true';

export function App() {
  return (
    <main className="ft-shell">
      <header className="ft-header">
        <h1 className="ft-wordmark">Throughline</h1>
        <p className="ft-tagline">The River is universal. Every family weaves their thread through it.</p>
      </header>
      {FLAG_ON ? (
        <VoiceSession />
      ) : (
        <section className="ft-card ft-card--muted">
          <h2>First Thread — voice Companion</h2>
          <p>
            This feature is behind the <code>first_thread_voice</code> flag and is currently off. Set{' '}
            <code>VITE_FIRST_THREAD_VOICE=true</code> (and the server's <code>FIRST_THREAD_VOICE=true</code>) to enable
            it.
          </p>
        </section>
      )}
      <footer className="ft-footer" aria-hidden="false">
        <span className="ft-build" title="Build (day-of-year · year : seconds past midnight, UTC)">
          build {BUILD_ID}
        </span>
        <button type="button" className="ft-diag-link" onClick={() => downloadDiagLog()}>
          diagnostics
        </button>
      </footer>
    </main>
  );
}
