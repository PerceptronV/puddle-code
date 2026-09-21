import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { accountSchema, projectSchema, sessionSchema, type Session } from '@puddle/shared';
import { api } from '../../lib/api';
import { browserScope } from '../../lib/browser-transport';
import { wsManager } from '../../lib/ws';
import { LazyTerminal } from '../terminal/LazyTerminal';
import { profileStore } from '../profile/profile-store';
import { Composer } from './Composer';
import { PhoneReview } from './PhoneReview';
import { SessionActions } from './SessionActions';

export function PhoneWorkspace({ connected }: { connected: boolean }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState(
    () => localStorage.getItem(browserScope('phone.project')) ?? '',
  );
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem(browserScope('phone.session')) ?? '',
  );
  const [term, setTerm] = useState('agent');
  const [review, setReview] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const [account, setAccount] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState(wsManager.isConnected());
  const [terminals, setTerminals] = useState<Array<{ session: string; term: string }>>([]);
  const projects = useQuery({
    queryKey: ['phone-projects'],
    queryFn: async () => projectSchema.array().parse(await api('GET', '/api/projects')),
  });
  const sessions = useQuery({
    queryKey: ['phone-sessions', projectId],
    queryFn: async () =>
      sessionSchema.array().parse(await api('GET', `/api/sessions?project=${projectId}`)),
    enabled: !!projectId,
    refetchInterval: connected ? 10_000 : false,
  });
  const project = projects.data?.find((project) => project.id === projectId);
  const accounts = useQuery({
    queryKey: ['phone-accounts', project?.profile_id],
    queryFn: async () =>
      accountSchema.array().parse(await api('GET', `/api/accounts?profile=${project!.profile_id}`)),
    enabled: !!project,
  });
  const session = sessions.data?.find((session) => session.id === sessionId);
  useEffect(() => wsManager.onConnectionChange(setAttached), []);
  useEffect(
    () =>
      wsManager.onStatus(() => {
        void qc.invalidateQueries({ queryKey: ['phone-sessions'] });
      }),
    [qc],
  );
  useEffect(
    () =>
      wsManager.onSessionsChanged(() => {
        void qc.invalidateQueries({ queryKey: ['phone-sessions'] });
      }),
    [qc],
  );
  useEffect(
    () =>
      wsManager.onRenamed(() => {
        void qc.invalidateQueries({ queryKey: ['phone-sessions'] });
      }),
    [qc],
  );
  useEffect(
    () =>
      wsManager.onSessionSwitched((event) => {
        void qc.invalidateQueries({ queryKey: ['phone-sessions'] });
        if (event.source_session !== sessionId) return;
        setProjectId(event.target_project);
        setSessionId(event.target_session);
        setReview(false);
        localStorage.setItem(browserScope('phone.project'), event.target_project);
        localStorage.setItem(browserScope('phone.session'), event.target_session);
      }),
    [sessionId, qc],
  );
  useEffect(() => {
    if (project) profileStore.set(project.profile_id);
  }, [project]);
  useEffect(() => {
    if (!session) return;
    setTerminals((current) =>
      current.some((entry) => entry.session === session.id && entry.term === term)
        ? current
        : [...current, { session: session.id, term }],
    );
  }, [session, term]);
  const choose = (next: Session) => {
    setSessionId(next.id);
    setTerm('agent');
    setReview(false);
    localStorage.setItem(browserScope('phone.session'), next.id);
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['phone-sessions'] });
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Operation failed; check the current session before retrying',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone-workspace">
      <nav className="phone-selectors">
        <select
          aria-label="Project"
          value={projectId}
          onChange={(event) => {
            const id = event.target.value;
            setProjectId(id);
            setSessionId('');
            localStorage.setItem(browserScope('phone.project'), id);
          }}
        >
          <option value="">Choose project</option>
          {projects.data
            ?.filter((p) => !p.archived)
            .map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
        </select>
        <select
          aria-label="Session"
          value={sessionId}
          onChange={(event) => {
            const selected = sessions.data?.find((s) => s.id === event.target.value);
            if (selected) choose(selected);
          }}
        >
          <option value="">Choose session</option>
          {sessions.data?.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8)}{' '}
              · {session.status}
            </option>
          ))}
        </select>
        <button disabled={!project || !connected} onClick={() => setNewSession(!newSession)}>
          New
        </button>
      </nav>
      {newSession && (
        <form
          className="phone-new"
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const created = sessionSchema.parse(
                await api('POST', '/api/sessions', {
                  project_id: projectId,
                  ...(account
                    ? { kind: 'agent', account_id: Number(account) }
                    : { kind: 'terminal' }),
                  ...(title ? { title } : {}),
                }),
              );
              choose(created);
              setNewSession(false);
              setTitle('');
            });
          }}
        >
          <label>
            Agent account
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Shell</option>
              {accounts.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.agent_type} · {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title (optional)
            <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <button disabled={busy || !connected} type="submit">
            Create session
          </button>
        </form>
      )}
      {session && (
        <nav className="phone-actions">
          <button onClick={() => setReview(false)}>Terminal</button>
          <button onClick={() => setReview(true)}>Review</button>
          {!review && (
            <select aria-label="Terminal" value={term} onChange={(e) => setTerm(e.target.value)}>
              <option value="agent">{session.kind === 'terminal' ? 'Shell' : 'Agent'}</option>
              {terminals
                .filter((t) => t.session === sessionId && t.term !== 'agent')
                .map((t) => (
                  <option key={t.term} value={t.term}>
                    {t.term}
                  </option>
                ))}
            </select>
          )}
          <SessionActions
            key={session.id}
            session={session}
            connected={connected}
            attached={attached}
            busy={busy}
            action={action}
            shell={(term) => {
              setTerm(term);
              setReview(false);
            }}
          />
        </nav>
      )}
      <div className="phone-view">
        {terminals.map((entry) => {
          const active = !review && !!session && entry.session === sessionId && entry.term === term;
          return (
            <div key={`${entry.session}:${entry.term}`} className="phone-terminal" hidden={!active}>
              <LazyTerminal
                stream={entry.session}
                term={entry.term}
                paused={!active || !connected}
              />
            </div>
          );
        })}
        {review && session && <PhoneReview key={session.id} session={session.id} />}
        {!session && <p className="phone-empty">Choose a project and session to continue.</p>}
      </div>
      {session && !review && (
        <Composer
          key={`${session.id}:${term}`}
          session={session.id}
          term={term}
          connected={connected && attached}
        />
      )}
      {(message || projects.error || sessions.error) && (
        <p role="alert">{message || projects.error?.message || sessions.error?.message}</p>
      )}
    </div>
  );
}
