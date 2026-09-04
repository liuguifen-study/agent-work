import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';

/**
 * WORKERS — live god-triggered ephemeral Slack workers. Lifecycle comes from
 * `workers:list`; existing hive read APIs add the collaboration facts needed
 * for a quick scan without creating another source of truth.
 */
type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;
type WorkerSnapshot = WorkersData['live'][number];
type AgentDirectory = Awaited<ReturnType<typeof window.cth.hiveAgentDirectory>>;
type AgentDirectoryEntry = AgentDirectory['agents'][number];
type HiveRegistry = Awaited<ReturnType<typeof window.cth.hiveRegistry>>;
type LedgerTask = { id: string; title?: string; status?: string; assignee?: string };

const POLL_MS = 2000;

function relAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8
};
const metaRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontFamily: 'var(--cth-font-mono)',
  fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-700)'
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-900)', margin: '4px 0'
};

type WorkerSignal = 'critical' | 'held' | 'mail' | 'releasing' | 'working';

function workerSignal(w: WorkerSnapshot, directory?: AgentDirectoryEntry, onHold = false): WorkerSignal {
  if (directory?.breaker === 'constrained' || directory?.breaker === 'stopped') return 'critical';
  if (onHold) return 'held';
  if ((directory?.inboxBacklog ?? 0) > 0) return 'mail';
  if (w.status === 'releasing') return 'releasing';
  return 'working';
}

function StatusBadge({ signal }: { signal: WorkerSignal }) {
  const { t } = useTranslation();
  const visual: Record<WorkerSignal, { color: string; label: string }> = {
    critical: { color: 'var(--cth-status-blocked)', label: t('workersTab.needsAttention') },
    held: { color: 'var(--cth-status-waiting)', label: t('workersTab.onHold') },
    mail: { color: 'var(--cth-status-thinking)', label: t('workersTab.mailWaiting') },
    releasing: { color: 'var(--cth-status-idle)', label: t('workersTab.stopping') },
    working: { color: 'var(--cth-status-working)', label: t('workersTab.working') }
  };
  const current = visual[signal];
  return (
    <span role="status" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '18px', padding: '2px 8px 0',
      color: 'var(--cth-ink-900)', background: 'var(--cth-cream-100)',
      boxShadow: `inset 0 0 0 1px ${current.color}`
    }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, background: current.color }} />
      {current.label}
    </span>
  );
}

function readTasks(value: unknown): LedgerTask[] {
  if (!value || typeof value !== 'object') return [];
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((task): task is LedgerTask => (
    !!task && typeof task === 'object' && typeof (task as LedgerTask).id === 'string'
  ));
}

export function WorkersTab() {
  const { t } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [data, setData] = useState<WorkersData | null>(null);
  const [directory, setDirectory] = useState<AgentDirectory['agents']>([]);
  const [registry, setRegistry] = useState<HiveRegistry | null>(null);
  const [tasks, setTasks] = useState<LedgerTask[]>([]);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState(false);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      window.cth.listWorkers(),
      window.cth.hiveAgentDirectory(),
      window.cth.hiveRegistry(),
      window.cth.hiveTasks()
    ]);
    if (results[0].status === 'fulfilled') {
      setData(results[0].value);
      setLoadError(false);
    } else {
      setLoadError(true);
    }
    if (results[1].status === 'fulfilled') setDirectory(results[1].value.agents ?? []);
    if (results[2].status === 'fulfilled') setRegistry(results[2].value);
    if (results[3].status === 'fulfilled') setTasks(readTasks(results[3].value));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stop = useCallback(async (workerId: string) => {
    setStopping((current) => ({ ...current, [workerId]: true }));
    setStopErrors((current) => ({ ...current, [workerId]: '' }));
    try {
      const result = await window.cth.stopWorker(workerId);
      if (!result.ok) throw new Error(result.error ?? t('workersTab.stopFailed'));
    } catch (error) {
      setStopErrors((current) => ({
        ...current,
        [workerId]: error instanceof Error ? error.message : t('workersTab.stopFailed')
      }));
    } finally {
      setStopping((current) => ({ ...current, [workerId]: false }));
      void refresh();
    }
  }, [refresh, t]);

  const live = data?.live ?? [];
  const preserved = data?.preserved ?? [];
  const max = data?.maxWorkers ?? 4;
  const directoryById = new Map(directory.map((entry) => [entry.id, entry]));
  const activeTasks = tasks.filter((task) => task.status === 'doing');
  const attentionCount = live.filter((worker) => {
    const entry = directoryById.get(worker.workerId);
    const onHold = !!registry?.agents?.[worker.workerId]?.onHold;
    return workerSignal(worker, entry, onHold) !== 'working';
  }).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 16px 16px', overflow: 'auto' }}>
      <section aria-labelledby="live-workers-heading">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span id="live-workers-heading" style={sectionHead}>{t('workersTab.liveWorkers')}</span>
          <span aria-label={t('workersTab.capacityAria', { live: live.length, max })} style={{
            fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-700)',
            background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: '2px 8px'
          }}>
            {t('workersTab.capacity', { live: live.length, max })}
          </span>
        </div>
        <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)', margin: '4px 0 8px' }}>
          {t('workersTab.liveIntro', { godName })}
        </p>

        {live.length > 0 && (
          <div role="status" aria-live="polite" style={{
            display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8, padding: '8px 12px',
            background: attentionCount > 0 ? 'var(--cth-lemon-light)' : 'var(--cth-mint-light)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
          }}>
            <span>{t('workersTab.runningSummary', { count: live.length })}</span>
            <span>{attentionCount > 0
              ? t('workersTab.attentionSummary', { count: attentionCount })
              : t('workersTab.allClear')}</span>
          </div>
        )}

        {loadError && (
          <div role="alert" style={{ ...card, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
            {t('workersTab.loadFailed')}
          </div>
        )}

        {!loadError && live.length === 0 ? (
          <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
            {t('workersTab.noneRunning')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {live.map((w) => {
              const entry = directoryById.get(w.workerId);
              const onHold = !!registry?.agents?.[w.workerId]?.onHold;
              const signal = workerSignal(w, entry, onHold);
              const owned = activeTasks.filter((task) => task.assignee === w.workerId || task.id === w.reqId);
              const firstTask = owned[0];
              const borderColor = signal === 'critical' ? 'var(--cth-coral)'
                : signal === 'held' ? 'var(--cth-status-waiting)'
                  : signal === 'mail' ? 'var(--cth-status-thinking)'
                    : 'var(--cth-ink-300)';
              const activityMs = typeof entry?.lastActiveSecAgo === 'number'
                ? entry.lastActiveSecAgo * 1000
                : w.idleMs;

              return (
                <article key={w.workerId} aria-label={t('workersTab.workerAria', { name: w.name })} style={{
                  ...card,
                  boxShadow: `inset 4px 0 0 ${borderColor}, inset 0 0 0 1px var(--cth-ink-300)`
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                      <StatusBadge signal={signal} />
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-900)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>{w.name}</span>
                      {w.hasSlack && (
                        <span title={t('workersTab.repliesToSlack')} style={{
                          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: '1px 6px'
                        }}>slack</span>
                      )}
                    </div>
                    <PixelButton
                      onClick={() => { void stop(w.workerId); }}
                      disabled={w.releasing || !!stopping[w.workerId]}
                      aria-label={t('workersTab.stopAria', { name: w.name })}
                    >
                      {w.releasing || stopping[w.workerId] ? t('workersTab.stoppingEllipsis') : t('workersTab.stop')}
                    </PixelButton>
                  </div>

                  <div style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center',
                    padding: 8, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                  }}>
                    <span title={firstTask?.title ?? firstTask?.id ?? w.reqId} style={{
                      minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                    }}>
                      {firstTask
                        ? t('workersTab.ownsTask', { task: firstTask.title ?? firstTask.id })
                        : t('workersTab.requestOwner', { request: w.reqId })}
                    </span>
                    {owned.length > 1 && (
                      <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                        {t('workersTab.moreTasks', { count: owned.length - 1 })}
                      </span>
                    )}
                  </div>

                  <div style={metaRow}>
                    <span title={t('workersTab.workerIdTitle')}>{w.workerId}</span>
                    <span title={t('workersTab.baseBranchTitle')}>{t('workersTab.base', { branch: w.baseBranch })}</span>
                    <span title={t('workersTab.upSinceTitle')}>{t('workersTab.up', { age: relAge(w.ageMs) })}</span>
                    <span title={t('workersTab.lastActivityTitle')}>
                      {activityMs === null ? t('workersTab.ptyGone') : t('workersTab.lastActive', { age: relAge(activityMs) })}
                    </span>
                    {entry?.lastTool && <span>{t('workersTab.lastTool', { tool: entry.lastTool })}</span>}
                    <span title={t('workersTab.tokensTitle')}>
                      {t('workersTab.tokens', { value: fmtTokens(w.tokensUsed) })}{w.tokenCap !== null ? ` / ${fmtTokens(w.tokenCap)}` : ` · ${t('workersTab.uncapped')}`}
                    </span>
                    {(entry?.inboxBacklog ?? 0) > 0 && (
                      <span style={{ color: 'var(--cth-ink-900)', background: 'var(--cth-sky-light)', padding: '0 4px' }}>
                        {t('workersTab.inboxBacklog', { count: entry!.inboxBacklog })}
                      </span>
                    )}
                    {onHold && <span style={{ color: 'var(--cth-ink-900)' }}>{t('workersTab.holdDetail')}</span>}
                    {entry?.breaker && entry.breaker !== 'healthy' && (
                      <span style={{ color: signal === 'critical' ? 'var(--cth-coral)' : 'var(--cth-ink-700)' }}>
                        {t('workersTab.breaker', { level: entry.breaker })}
                      </span>
                    )}
                  </div>

                  {stopErrors[w.workerId] && (
                    <div role="alert" style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-coral)' }}>
                      {t('workersTab.stopError', { error: stopErrors[w.workerId] })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {preserved.length > 0 && (
        <section aria-labelledby="preserved-workers-heading">
          <span id="preserved-workers-heading" style={sectionHead}>{t('workersTab.preserved', { count: preserved.length })}</span>
          <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)', margin: '4px 0 8px' }}>
            {t('workersTab.preservedIntro')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preserved.map((p) => (
              <article key={p.wtPath} aria-label={t('workersTab.preservedAria', { id: p.workerId })} style={card}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-900)' }}>
                  {p.workerId}
                </div>
                <div style={metaRow}>
                  <span style={{ wordBreak: 'break-all' }}>{p.wtPath}</span>
                  <span>{t('workersTab.base', { branch: p.baseBranch })}</span>
                  <span>{t('workersTab.keptAgo', { age: relAge(Math.max(0, Date.now() - p.preservedAt)) })}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
