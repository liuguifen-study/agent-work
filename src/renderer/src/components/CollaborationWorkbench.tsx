import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentDetailPanel } from './AgentDetailPanel';
import { FileTree } from './FileTree';
import { Icon } from './Icon';
import { PixelButton } from './PixelButton';
import { PixelPanel } from './PixelPanel';
import { parseTasks, waitsOnHuman, type HiveTask } from './TasksKanban';
import { useStore, type Agent, type GodStatus } from '@/store/store';
import type { HarnessConfig } from '@/store/config';

const TASK_POLL_MS = 5_000;
const COORDINATION_POLL_MS = 30_000;
const AUTO_COORDINATION_TAG = '[auto-coordination]';

export interface CollaborationWorkbenchProps {
  agent?: Agent;
  config: HarnessConfig;
  godStatus: GodStatus;
  bootingGodName: string;
  onAddAgent: () => void;
}

/**
 * The main product surface.  The old office was an attractive status display,
 * but it hid the three things an operator repeatedly needs while coordinating a
 * real team: the workspace, the active conversation, and the work ledger.
 * This component makes those three surfaces permanent neighbours instead.
 */
export function CollaborationWorkbench({
  agent,
  config,
  godStatus,
  bootingGodName,
  onAddAgent
}: CollaborationWorkbenchProps) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const messageQueues = useStore((s) => s.messageQueues);
  const select = useStore((s) => s.select);
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const [filesOpen, setFilesOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);

  const workspaceRoot = agent?.cwd
    ?? agents.find((candidate) => !!candidate.cwd)?.cwd
    ?? config.registeredRepos[0]
    ?? config.harnessHome
    ?? '';
  const god = agents.find((candidate) => candidate.isGod);
  const working = agents.filter((candidate) => candidate.status === 'working').length;
  const blocked = agents.filter((candidate) => candidate.status === 'blocked').length;
  const queued = Object.values(messageQueues).reduce((count, entries) => count + entries.length, 0);

  useAutoCoordination(config.autoMode, agents, messageQueues);

  const coordinateNow = useCallback(() => {
    if (!god) return;
    const summary = coordinationSummary(agents, messageQueues);
    enqueueMessage(god.id, t('workbench.coordinateMessage', { summary }), {
      instruction: buildCoordinationInstruction(summary, 'manual')
    });
    select(god.id);
    requestCommandCenterTab('floor');
  }, [agents, enqueueMessage, god, messageQueues, requestCommandCenterTab, select, t]);

  return (
    <div
      className="cth-workbench"
      style={{
        gridTemplateColumns: `${filesOpen ? 'minmax(220px, 18vw)' : '42px'} minmax(380px, 1fr) ${tasksOpen ? 'minmax(260px, 23vw)' : '42px'}`
      }}
    >
      <section className="cth-workbench-rail" aria-label={t('workbench.files')}>
        {filesOpen ? (
          <WorkspaceFilesRail
            root={workspaceRoot}
            project={agent?.project}
            onCollapse={() => setFilesOpen(false)}
          />
        ) : (
          <CollapsedRail
            label={t('workbench.files')}
            icon="folder"
            onExpand={() => setFilesOpen(true)}
          />
        )}
      </section>

      <main className="cth-workbench-main">
        <TeamPulse
          agents={agents}
          selectedId={agent?.id}
          messageQueues={messageQueues}
          working={working}
          blocked={blocked}
          queued={queued}
          autoMode={!!config.autoMode}
          onSelect={select}
          onCoordinate={god ? coordinateNow : undefined}
          onAddAgent={onAddAgent}
        />
        <div className="cth-workbench-agent">
          {agent ? (
            <AgentDetailPanel agent={agent} />
          ) : godStatus === 'booting' ? (
            <WorkspaceEmptyState
              eyebrow={t('workbench.starting')}
              title={t('workbench.startingTitle', { name: bootingGodName })}
              body={t('workbench.startingBody')}
            />
          ) : (
            <WorkspaceEmptyState
              eyebrow={t('workbench.noAgent')}
              title={t('workbench.noAgentTitle')}
              body={t('workbench.noAgentBody')}
              onAddAgent={onAddAgent}
            />
          )}
        </div>
      </main>

      <section className="cth-workbench-rail" aria-label={t('workbench.tasks')}>
        {tasksOpen ? (
          <TaskRail onCollapse={() => setTasksOpen(false)} />
        ) : (
          <CollapsedRail
            label={t('workbench.tasks')}
            icon="check"
            onExpand={() => setTasksOpen(true)}
          />
        )}
      </section>
    </div>
  );
}

function WorkspaceFilesRail({ root, project, onCollapse }: { root: string; project?: string; onCollapse: () => void }) {
  const { t } = useTranslation();
  const openFileInIde = useStore((s) => s.openFileInIde);
  const setIdeOpen = useStore((s) => s.setIdeOpen);
  const [active, setActive] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => setActive(null), [root]);

  const join = (rel: string): string => rel ? `${root}/${rel}` : root;
  const copyPath = (rel: string) => {
    void navigator.clipboard.writeText(join(rel)).catch(() => undefined);
  };

  return (
    <PixelPanel variant="default" noPadding className="cth-workbench-panel">
      <RailHeader
        eyebrow={t('workbench.files')}
        title={project || shortPath(root) || t('workbench.workspace')}
        onCollapse={onCollapse}
        collapseTitle={t('workbench.collapseFiles')}
      />
      {root ? (
        <>
          <div className="cth-workbench-filetree">
            <FileTree
              key={`${root}:${refreshKey}`}
              root={root}
              activeRel={active ?? undefined}
              onOpenFile={setActive}
              onCopyPath={copyPath}
            />
          </div>
          <div className="cth-workbench-rail-footer">
            <span className="cth-workbench-path" title={active ? join(active) : root}>
              {active || t('workbench.selectFile')}
            </span>
            <div className="cth-workbench-actions">
              <button
                type="button"
                className="cth-workbench-icon-button cth-tip"
                data-tip={t('workbench.refreshFiles')}
                aria-label={t('workbench.refreshFiles')}
                onClick={() => setRefreshKey((value) => value + 1)}
              >⟳</button>
              <PixelButton
                variant="secondary"
                size="sm"
                onClick={() => active ? openFileInIde(join(active)) : setIdeOpen(true)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="code" /> {t('workbench.open')}
                </span>
              </PixelButton>
            </div>
          </div>
        </>
      ) : (
        <RailEmpty label={t('workbench.noWorkspace')} />
      )}
    </PixelPanel>
  );
}

function TaskRail({ onCollapse }: { onCollapse: () => void }) {
  const { t } = useTranslation();
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const agents = useStore((s) => s.agents);
  const select = useStore((s) => s.select);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [filter, setFilter] = useState<'all' | 'attention' | 'doing'>('all');

  const refresh = useCallback(async () => {
    try { setTasks(parseTasks(await window.cth.hiveTasks())); } catch { /* retain the last good ledger */ }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, TASK_POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const counts = useMemo(() => ({
    attention: tasks.filter((task) => task.status === 'blocked' || waitsOnHuman(task)).length,
    doing: tasks.filter((task) => task.status === 'doing').length,
    todo: tasks.filter((task) => task.status === 'todo').length,
    done: tasks.filter((task) => task.status === 'done').length
  }), [tasks]);
  const visible = useMemo(() => tasks
    .filter((task) => filter === 'all'
      || (filter === 'attention' && (task.status === 'blocked' || waitsOnHuman(task)))
      || (filter === 'doing' && task.status === 'doing'))
    .sort(compareTasks), [filter, tasks]);
  const nameFor = (id?: string): string | undefined => id ? agents.find((agent) => agent.id === id)?.name ?? id : undefined;

  const routeNewWork = () => {
    const god = agents.find((agent) => agent.isGod);
    if (!god) return;
    select(god.id);
    requestCommandCenterTab('floor');
  };

  return (
    <PixelPanel variant="default" noPadding className="cth-workbench-panel">
      <RailHeader
        eyebrow={t('workbench.tasks')}
        title={t('workbench.taskSubtitle', { count: tasks.length })}
        onCollapse={onCollapse}
        collapseTitle={t('workbench.collapseTasks')}
        action={
          <button
            type="button"
            className="cth-workbench-icon-button cth-tip"
            data-tip={t('workbench.routeWork')}
            aria-label={t('workbench.routeWork')}
            onClick={routeNewWork}
          ><Icon name="plus" /></button>
        }
      />
      <div className="cth-workbench-task-summary">
        <TaskSummary label={t('workbench.attention')} count={counts.attention} active={filter === 'attention'} tone="coral" onClick={() => setFilter(filter === 'attention' ? 'all' : 'attention')} />
        <TaskSummary label={t('workbench.doing')} count={counts.doing} active={filter === 'doing'} tone="lemon" onClick={() => setFilter(filter === 'doing' ? 'all' : 'doing')} />
        <TaskSummary label={t('workbench.todo')} count={counts.todo} tone="sky" onClick={() => setFilter('all')} />
        <TaskSummary label={t('workbench.done')} count={counts.done} tone="mint" onClick={() => setFilter('all')} />
      </div>
      <div className="cth-workbench-task-list">
        {visible.length === 0 ? <RailEmpty label={t('workbench.noTasks')} /> : visible.map((task) => (
          <button
            key={task.id}
            type="button"
            className={`cth-workbench-task-card cth-workbench-task-${task.status}`}
            onClick={() => openTaskDetail(task.id)}
          >
            <span className="cth-workbench-task-card-top">
              <span className="cth-workbench-task-status">{task.status === 'blocked' ? '!' : task.status === 'doing' ? '•' : task.status === 'done' ? '✓' : '○'}</span>
              <span className="cth-workbench-task-title">{task.title}</span>
            </span>
            <span className="cth-workbench-task-meta">
              <span>{nameFor(task.assignee) || t('workbench.unassigned')}</span>
              <span>{t('workbench.priority', { level: Math.max(1, Math.min(5, task.priority)) })}</span>
            </span>
            {(waitsOnHuman(task) || task.dependsOn.length > 0) && (
              <span className="cth-workbench-task-flags">
                {waitsOnHuman(task) ? t('workbench.needsYou') : t('workbench.dependencies', { count: task.dependsOn.length })}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="cth-workbench-sync-note">{t('workbench.synced')}</div>
    </PixelPanel>
  );
}

function TeamPulse({
  agents,
  selectedId,
  messageQueues,
  working,
  blocked,
  queued,
  autoMode,
  onSelect,
  onCoordinate,
  onAddAgent
}: {
  agents: Agent[];
  selectedId?: string;
  messageQueues: Record<string, Array<unknown>>;
  working: number;
  blocked: number;
  queued: number;
  autoMode: boolean;
  onSelect: (id: string) => void;
  onCoordinate?: () => void;
  onAddAgent: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="cth-workbench-pulse">
      <div className="cth-workbench-pulse-copy">
        <span className="cth-workbench-eyebrow">{t('workbench.collaboration')}</span>
        <span className="cth-workbench-pulse-title">{t('workbench.teamSummary', { count: agents.length })}</span>
      </div>
      <div className="cth-workbench-metrics" aria-label={t('workbench.teamStatus')}>
        <Metric label={t('workbench.working')} value={working} tone="mint" />
        <Metric label={t('workbench.blocked')} value={blocked} tone={blocked ? 'coral' : 'neutral'} />
        <Metric label={t('workbench.queued')} value={queued} tone={queued ? 'lemon' : 'neutral'} />
        <Metric label={autoMode ? t('workbench.autoOn') : t('workbench.autoOff')} value={autoMode ? 'A' : '–'} tone={autoMode ? 'sky' : 'neutral'} />
      </div>
      <div className="cth-workbench-team-list">
        {agents.slice(0, 7).map((member) => (
          <button
            key={member.id}
            type="button"
            onClick={() => onSelect(member.id)}
            className={`cth-workbench-member ${selectedId === member.id ? 'is-selected' : ''}`}
            title={`${member.name}: ${member.action || member.status}`}
          >
            <span className={`cth-workbench-member-dot is-${member.status}`} />
            <span>{member.name}</span>
            {(messageQueues[member.id]?.length ?? 0) > 0 && <small>{messageQueues[member.id].length}</small>}
          </button>
        ))}
      </div>
      <div className="cth-workbench-pulse-actions">
        {onCoordinate && (
          <PixelButton variant="primary" size="sm" onClick={onCoordinate}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="sparkle" /> {t('workbench.coordinateNow')}</span>
          </PixelButton>
        )}
        <PixelButton variant="secondary" size="sm" onClick={onAddAgent}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="plus" /> {t('workbench.addAgent')}</span>
        </PixelButton>
      </div>
    </div>
  );
}

function useAutoCoordination(enabled: boolean, agents: Agent[], queues: Record<string, Array<{ text: string; instruction?: string }>>) {
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const lastSignature = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) { lastSignature.current = null; return; }
    let cancelled = false;
    const evaluate = async () => {
      const god = agents.find((agent) => agent.isGod && agent.ptyId);
      if (!god) return;
      let tasks: HiveTask[] = [];
      try { tasks = parseTasks(await window.cth.hiveTasks()); } catch { return; }
      if (cancelled) return;
      const summary = coordinationSummary(agents, queues, tasks);
      if (!summary) { lastSignature.current = null; return; }
      const signature = summary.slice(0, 180);
      const tag = `${AUTO_COORDINATION_TAG}:${signature}`;
      const queuedAlready = (queues[god.id] ?? []).some((message) => message.instruction?.includes(tag));
      if (lastSignature.current === signature || queuedAlready) return;
      lastSignature.current = signature;
      enqueueMessage(god.id, `Automatic coordination pulse: ${summary}`, {
        instruction: buildCoordinationInstruction(summary, tag)
      });
    };
    void evaluate();
    const interval = window.setInterval(() => { void evaluate(); }, COORDINATION_POLL_MS);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [agents, enabled, enqueueMessage, queues]);
}

function coordinationSummary(
  agents: Agent[],
  queues: Record<string, Array<unknown>>,
  tasks: HiveTask[] = []
): string {
  const blockedAgents = agents.filter((agent) => agent.status === 'blocked').length;
  const queuePressure = Object.values(queues).filter((entries) => entries.length >= 3).length;
  const blockedTasks = tasks.filter((task) => task.status === 'blocked').length;
  const unassigned = tasks.filter((task) => task.status !== 'done' && !task.assignee).length;
  const facts = [
    blockedAgents ? `${blockedAgents} blocked agent${blockedAgents === 1 ? '' : 's'}` : '',
    blockedTasks ? `${blockedTasks} blocked task${blockedTasks === 1 ? '' : 's'}` : '',
    unassigned ? `${unassigned} unassigned task${unassigned === 1 ? '' : 's'}` : '',
    queuePressure ? `${queuePressure} busy queue${queuePressure === 1 ? '' : 's'}` : ''
  ].filter(Boolean);
  return facts.join(', ');
}

function buildCoordinationInstruction(summary: string, tag: string): string {
  return [
    tag,
    'COORDINATION PULSE',
    `Signals: ${summary}.`,
    'Inspect the task ledger and current team status. Reassign only unowned work, unblock dependencies where possible, and send each affected agent one concrete next-step message.',
    'Do not duplicate work already in progress. Update task states when the plan changes, then report a concise coordination summary.'
  ].join('\n');
}

function RailHeader({ eyebrow, title, onCollapse, collapseTitle, action }: { eyebrow: string; title: string; onCollapse: () => void; collapseTitle: string; action?: React.ReactNode }) {
  return (
    <div className="cth-workbench-rail-header">
      <div className="cth-workbench-rail-heading">
        <span className="cth-workbench-eyebrow">{eyebrow}</span>
        <span className="cth-workbench-rail-title" title={title}>{title}</span>
      </div>
      <div className="cth-workbench-actions">
        {action}
        <button type="button" className="cth-workbench-icon-button" onClick={onCollapse} title={collapseTitle} aria-label={collapseTitle}>‹</button>
      </div>
    </div>
  );
}

function CollapsedRail({ label, icon, onExpand }: { label: string; icon: Parameters<typeof Icon>[0]['name']; onExpand: () => void }) {
  return (
    <div className="cth-workbench-collapsed-rail">
      <button type="button" onClick={onExpand} title={label} aria-label={label}><Icon name={icon} /></button>
      <span>{label}</span>
    </div>
  );
}

function WorkspaceEmptyState({ eyebrow, title, body, onAddAgent }: { eyebrow: string; title: string; body: string; onAddAgent?: () => void }) {
  const { t } = useTranslation();
  return (
    <PixelPanel variant="default" noPadding style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
      <div style={{ maxWidth: 380, padding: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
        <span className="cth-workbench-eyebrow">{eyebrow}</span>
        <strong style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '18px' }}>{title}</strong>
        <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-500)' }}>{body}</p>
        {onAddAgent && <PixelButton variant="primary" size="md" onClick={onAddAgent}><Icon name="plus" /> {t('workbench.addAgent')}</PixelButton>}
      </div>
    </PixelPanel>
  );
}

function TaskSummary({ label, count, tone, active, onClick }: { label: string; count: number; tone: 'coral' | 'lemon' | 'sky' | 'mint'; active?: boolean; onClick: () => void }) {
  return <button type="button" className={`cth-workbench-summary is-${tone} ${active ? 'is-active' : ''}`} onClick={onClick}><strong>{count}</strong><span>{label}</span></button>;
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone: 'mint' | 'coral' | 'lemon' | 'sky' | 'neutral' }) {
  return <span className={`cth-workbench-metric is-${tone}`}><strong>{value}</strong><span>{label}</span></span>;
}

function RailEmpty({ label }: { label: string }) {
  return <div className="cth-workbench-rail-empty">{label}</div>;
}

function compareTasks(a: HiveTask, b: HiveTask): number {
  const weight: Record<HiveTask['status'], number> = { blocked: 0, doing: 1, todo: 2, done: 3 };
  return weight[a.status] - weight[b.status] || a.priority - b.priority || b.createdAt.localeCompare(a.createdAt);
}

function shortPath(path: string): string {
  const chunks = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return chunks[chunks.length - 1] ?? path;
}
