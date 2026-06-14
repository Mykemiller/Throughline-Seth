import { useCallback, useEffect, useMemo, useState } from 'react';
import { VoiceProvider, useVoice } from '@humeai/voice-react';
import type { SessionStateSnapshot } from '@throughline/shared';
import { CHAPTER_ORDER } from '@throughline/shared';
import { createSession, fetchHumeToken, fetchResumable, fetchSessionState, setChapter, setSessionStatus } from './api';
import { useTranscriptPersistence } from './useTranscriptPersistence';
import { PhotoCapture } from './PhotoCapture';

interface Ready {
  accessToken: string;
  configId: string;
  sessionId: string;
  snapshot: SessionStateSnapshot;
  resumed: boolean;
}

/**
 * Boots a First Thread session: mints a Hume access token, then either RESUMES
 * the most recent in-progress session (E13-08 — closed doors stay closed
 * across resume) or creates a fresh rot_capture_sessions row.
 */
export function VoiceSession() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ accessToken, configId }, resumable] = await Promise.all([
          fetchHumeToken(),
          fetchResumable(),
        ]);
        if (resumable.sessionId && resumable.snapshot) {
          if (!cancelled)
            setReady({
              accessToken,
              configId,
              sessionId: resumable.sessionId,
              snapshot: resumable.snapshot,
              resumed: true,
            });
          return;
        }
        const { sessionId, snapshot } = await createSession();
        if (!cancelled) setReady({ accessToken, configId, sessionId, snapshot, resumed: false });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <section className="ft-card ft-card--muted">
        <h2>Couldn’t start the session</h2>
        <p className="ft-error">{error}</p>
        <p>
          Check that the server is running with <code>FIRST_THREAD_VOICE=true</code> and all secrets set.
        </p>
      </section>
    );
  }

  if (!ready) {
    return (
      <section className="ft-card">
        <p>Preparing your First Thread…</p>
      </section>
    );
  }

  return <ConnectedSession {...ready} />;
}

function ConnectedSession({ accessToken, configId, sessionId, snapshot, resumed }: Ready) {
  const { handleMessage } = useTranscriptPersistence(sessionId);
  return (
    <VoiceProvider onMessage={handleMessage} onError={(e) => console.error('[hume]', e)}>
      <SethPanel
        accessToken={accessToken}
        configId={configId}
        sessionId={sessionId}
        initialSnapshot={snapshot}
        resumed={resumed}
      />
    </VoiceProvider>
  );
}

/** Display titles for the locked v0.2 chapter spine. */
const CHAPTER_LABELS: Record<string, string> = {
  first_light: 'First Light',
  school_years: 'The School Years',
  becoming: 'Becoming',
  world_you_built: 'The World You Built',
  what_stayed: 'What Stayed',
  still_becoming: 'Still Becoming',
  last_night: 'Last Night',
};

function SethPanel({
  accessToken,
  configId,
  sessionId,
  initialSnapshot,
  resumed,
}: {
  accessToken: string;
  configId: string;
  sessionId: string;
  initialSnapshot: SessionStateSnapshot;
  resumed: boolean;
}) {
  const { connect, disconnect, status, isMuted, mute, unmute, messages } = useVoice();
  const [snapshot, setSnapshot] = useState(initialSnapshot);

  const connected = status.value === 'connected';
  const connecting = status.value === 'connecting';

  const refreshState = useCallback(async () => {
    try {
      const { snapshot: fresh } = await fetchSessionState(sessionId);
      setSnapshot(fresh);
    } catch (e) {
      console.error('state refresh failed', e);
    }
  }, [sessionId]);

  const [jumping, setJumping] = useState(false);
  const jumpTo = useCallback(
    async (chapterId: string) => {
      setJumping(true);
      try {
        const { snapshot: fresh } = await setChapter(sessionId, chapterId);
        setSnapshot(fresh);
      } catch (e) {
        console.error('chapter jump failed', e);
      } finally {
        setJumping(false);
      }
    },
    [sessionId],
  );

  // The flow state lives server-side; poll lightly while connected so the
  // chapter marker and photo affordance track the conversation.
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => void refreshState(), 4000);
    return () => clearInterval(t);
  }, [connected, refreshState]);

  const start = async () => {
    try {
      await connect({
        auth: { type: 'accessToken', value: accessToken },
        configId,
        sessionSettings: { type: 'session_settings', customSessionId: sessionId },
      });
    } catch (e) {
      console.error('[hume] connect failed', e);
    }
  };

  const end = async () => {
    disconnect();
    try {
      await setSessionStatus(sessionId, 'complete');
    } catch (e) {
      console.error('mark complete failed', e);
    }
  };

  const transcript = useMemo(
    () =>
      messages.filter(
        (m) => m.type === 'user_message' || m.type === 'assistant_message',
      ) as Array<{ type: string; message?: { content?: string } }>,
    [messages],
  );

  return (
    <div className="ft-session-layout">
      <aside className="ft-portrait" aria-label="Seth, your Companion">
        <img
          className="ft-portrait__img"
          src="/seth-portrait.jpg"
          alt="A portrait of Seth, your First Thread Companion"
        />
        <p className="ft-portrait__caption">Seth · your Companion</p>
      </aside>

      <section className="ft-card ft-session">
      <div className="ft-session__bar">
        <span className="ft-chapter">
          {snapshot.phase === 'intro'
            ? 'Introduction'
            : `Chapter · ${CHAPTER_LABELS[snapshot.chapterId] ?? snapshot.chapterId}`}
        </span>
        <span className={`ft-status ft-status--${status.value}`}>{status.value}</span>
      </div>

      {resumed && !connected && (
        <p className="ft-resume-note">
          Picking up where you left off — {CHAPTER_LABELS[snapshot.chapterId]}.
        </p>
      )}

      <p className="ft-seth-intro">
        When you begin, Seth will introduce himself and walk you through how this works. Speak
        naturally — you can pause and pick up later anytime, interrupt whenever you like, and if
        there’s anything you’d rather not talk about, just say so and we’ll leave it there.
      </p>

      <div className="ft-controls">
        {!connected ? (
          <button className="ft-btn ft-btn--primary" onClick={start} disabled={connecting}>
            {connecting ? 'Connecting…' : resumed ? 'Continue with Seth' : 'Begin with Seth'}
          </button>
        ) : (
          <>
            <button className="ft-btn" onClick={() => (isMuted ? unmute() : mute())}>
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button className="ft-btn ft-btn--end" onClick={end}>
              End session
            </button>
          </>
        )}
      </div>

      {connected && (
        <PhotoCapture
          sessionId={sessionId}
          hasActiveMoment={Boolean(snapshot.activeMomentId)}
          onPinned={() => void refreshState()}
        />
      )}

      <ol className="ft-transcript">
        {transcript.map((m, i) => (
          <li
            key={i}
            className={m.type === 'assistant_message' ? 'ft-line ft-line--seth' : 'ft-line ft-line--you'}
          >
            <span className="ft-line__who">{m.type === 'assistant_message' ? 'Seth' : 'You'}</span>
            <span className="ft-line__text">{m.message?.content}</span>
          </li>
        ))}
        {transcript.length === 0 && (
          <li className="ft-line ft-line--empty">Your conversation will appear here.</li>
        )}
      </ol>
      </section>

      <aside className="ft-rail" aria-label="Your story">
        <h2 className="ft-rail__title">
          {snapshot.subscriberName ? `${snapshot.subscriberName}\u2019s story` : 'Your story'}
        </h2>
        <ol className="ft-rail__list">
          <li
            className={`ft-rail__item ft-rail__item--intro ${
              snapshot.phase === 'intro' ? 'is-current' : 'is-done'
            }`}
          >
            <span className="ft-rail__dot" aria-hidden="true" />
            <span className="ft-rail__label">Introduction</span>
          </li>
          {CHAPTER_ORDER.map((id, i) => {
            const isCurrent = snapshot.phase === 'walk' && snapshot.chapterId === id;
            const done = (snapshot.confirmedMoments?.[id] ?? 0) > 0;
            return (
              <li
                key={id}
                className={`ft-rail__item ${isCurrent ? 'is-current' : ''} ${done ? 'is-done' : ''}`}
              >
                <button
                  className="ft-rail__btn"
                  onClick={() => void jumpTo(id)}
                  disabled={jumping}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span className="ft-rail__dot" aria-hidden="true" />
                  <span className="ft-rail__num">{i + 1}</span>
                  <span className="ft-rail__label">{CHAPTER_LABELS[id]}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="ft-rail__hint">
          Jump to any chapter whenever you like — your place is saved, and closed doors stay closed.
        </p>
      </aside>
    </div>
  );
}
