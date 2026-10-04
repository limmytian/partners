(function () {
  const state = {
    gatewayUrl: localStorage.getItem('partners_gateway_url') || '',
    adminToken: localStorage.getItem('partners_admin_token') || '',
    activeTab: 'overview',
    eventSource: null,
    refreshTimer: null,
    pendingAction: null,
  };

  // DOM Elements
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const refreshBtn = document.getElementById('refresh-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');

  // Settings Modal Elements
  const settingsModal = document.getElementById('settings-modal');
  const closeSettings = document.getElementById('close-settings');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const cfgGatewayUrl = document.getElementById('cfg-gateway-url');
  const cfgAdminToken = document.getElementById('cfg-admin-token');

  // Job Log Modal Elements
  const jobModal = document.getElementById('job-modal');
  const closeJobModal = document.getElementById('close-job-modal');
  const closeJobModalBtn = document.getElementById('close-job-modal-btn');
  const clearTerminalBtn = document.getElementById('clear-terminal-btn');
  const modalJobId = document.getElementById('modal-job-id');
  const terminalOutput = document.getElementById('terminal-output');

  // Confirm Modal Elements
  const confirmModal = document.getElementById('confirm-modal');
  const closeConfirmModal = document.getElementById('close-confirm-modal');
  const cancelConfirmBtn = document.getElementById('cancel-confirm-btn');
  const executeConfirmBtn = document.getElementById('execute-confirm-btn');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmMessage = document.getElementById('confirm-message');

  // Filter Elements
  const auditOutcomeFilter = document.getElementById('audit-outcome-filter');
  const auditActorFilter = document.getElementById('audit-actor-filter');
  const jobsStateFilter = document.getElementById('jobs-state-filter');
  const jobsTenantFilter = document.getElementById('jobs-tenant-filter');
  const sessionsStateFilter = document.getElementById('sessions-state-filter');

  // Terminal Modal Elements
  const terminalModal = document.getElementById('terminal-modal');
  const closeTerminalModal = document.getElementById('close-terminal-modal');
  const closeTerminalModalBtn = document.getElementById('close-terminal-modal-btn');
  const ptySessionId = document.getElementById('pty-session-id');
  const ptyStatusBadge = document.getElementById('pty-status-badge');
  const ptyTerminalOutput = document.getElementById('pty-terminal-output');
  const ptyInput = document.getElementById('pty-input');
  const ptySendBtn = document.getElementById('pty-send-btn');
  let activePtyWebSocket = null;

  // Snapshot & Template Modal Elements
  const snapshotModal = document.getElementById('snapshot-modal');
  const closeSnapshotModal = document.getElementById('close-snapshot-modal');
  const cancelSnapshotBtn = document.getElementById('cancel-snapshot-btn');
  const submitSnapshotBtn = document.getElementById('submit-snapshot-btn');
  const snapSessionId = document.getElementById('snap-session-id');
  const snapLabel = document.getElementById('snap-label');

  const templateModal = document.getElementById('template-modal');
  const closeTemplateModal = document.getElementById('close-template-modal');
  const cancelTemplateBtn = document.getElementById('cancel-template-btn');
  const submitTemplateBtn = document.getElementById('submit-template-btn');
  const tplSnapshotId = document.getElementById('tpl-snapshot-id');
  const tplName = document.getElementById('tpl-name');
  const tplDesc = document.getElementById('tpl-desc');

  // Preview Modal Elements
  const previewModal = document.getElementById('preview-modal');
  const closePreviewModal = document.getElementById('close-preview-modal');
  const closePreviewModalBtn = document.getElementById('close-preview-modal-btn');
  const previewTitle = document.getElementById('preview-title');
  const previewOpenExtLink = document.getElementById('preview-open-ext-link');
  const previewIframe = document.getElementById('preview-iframe');

  async function init() {
    // Fetch server default config if not set locally
    if (!state.gatewayUrl) {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const cfg = await res.json();
          state.gatewayUrl = cfg.gatewayUrl || '/api/proxy';
          localStorage.setItem('partners_gateway_url', state.gatewayUrl);
        }
      } catch {
        state.gatewayUrl = '/api/proxy';
      }
    }

    cfgGatewayUrl.value = state.gatewayUrl;
    cfgAdminToken.value = state.adminToken;

    bindEvents();
    switchTab('overview');
    startAutoRefresh();
  }

  function bindEvents() {
    // Navigation
    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        switchTab(tab);
      });
    });

    // Refresh button
    refreshBtn.addEventListener('click', () => refreshCurrentView());

    // Settings modal
    settingsBtn.addEventListener('click', () => {
      cfgGatewayUrl.value = state.gatewayUrl;
      cfgAdminToken.value = state.adminToken;
      settingsModal.classList.add('active');
    });
    closeSettings.addEventListener('click', () => settingsModal.classList.remove('active'));
    saveSettingsBtn.addEventListener('click', () => {
      state.gatewayUrl = cfgGatewayUrl.value.trim();
      state.adminToken = cfgAdminToken.value.trim();
      localStorage.setItem('partners_gateway_url', state.gatewayUrl);
      localStorage.setItem('partners_admin_token', state.adminToken);
      settingsModal.classList.remove('active');
      refreshCurrentView();
    });

    // Job Stream Modal
    const closeStream = () => {
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
      jobModal.classList.remove('active');
    };
    closeJobModal.addEventListener('click', closeStream);
    closeJobModalBtn.addEventListener('click', closeStream);
    clearTerminalBtn.addEventListener('click', () => {
      terminalOutput.innerHTML = '';
    });

    // Confirm Modal
    const closeConfirm = () => {
      confirmModal.classList.remove('active');
      state.pendingAction = null;
    };
    closeConfirmModal.addEventListener('click', closeConfirm);
    cancelConfirmBtn.addEventListener('click', closeConfirm);
    executeConfirmBtn.addEventListener('click', async () => {
      if (state.pendingAction) {
        await state.pendingAction();
        closeConfirm();
        refreshCurrentView();
      }
    });

    // Filters
    auditOutcomeFilter.addEventListener('change', () => loadAuditRecords());
    auditActorFilter.addEventListener('input', debounce(() => loadAuditRecords(), 300));
    jobsStateFilter.addEventListener('change', () => loadJobs());
    jobsTenantFilter.addEventListener('input', debounce(() => loadJobs(), 300));
    sessionsStateFilter.addEventListener('change', () => loadSessions());
  }

  function switchTab(tab) {
    state.activeTab = tab;
    navItems.forEach((item) => {
      item.classList.toggle('active', item.getAttribute('data-tab') === tab);
    });
    viewSections.forEach((section) => {
      section.classList.toggle('active', section.id === `view-${tab}`);
    });
    refreshCurrentView();
  }

  async function apiFetch(endpoint, options = {}) {
    const url = state.gatewayUrl.replace(/\/+$/, '') + endpoint;
    const headers = {
      ...(options.headers || {}),
    };
    if (state.adminToken) {
      headers['Authorization'] = `Bearer ${state.adminToken}`;
    }
    try {
      const res = await fetch(url, { ...options, headers });
      updateConnectionStatus(true);
      return res;
    } catch (err) {
      updateConnectionStatus(false, err.message);
      throw err;
    }
  }

  function updateConnectionStatus(isOnline, message = '') {
    if (isOnline) {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'Gateway Connected';
    } else {
      statusDot.className = 'status-dot offline';
      statusText.textContent = message ? `Offline: ${message}` : 'Gateway Disconnected';
    }
  }

  async function refreshCurrentView() {
    switch (state.activeTab) {
      case 'overview':
        await loadOverview();
        break;
      case 'audit':
        await loadAuditRecords();
        break;
      case 'jobs':
        await loadJobs();
        break;
      case 'sessions':
        await loadSessions();
        break;
      case 'templates':
        await loadTemplatesAndSnapshots();
        break;
      case 'capabilities':
        break;
      case 'idempotency':
        await loadIdempotencyKeys();
        break;
    }
  }

  // 1. Overview Tab
  async function loadOverview() {
    try {
      const res = await apiFetch('/v1/admin/overview');
      if (res.status === 401 || res.status === 403) {
        showAuthWarning('Overview requires a valid token with admin:read scope.');
        return;
      }
      const data = await res.json();

      document.getElementById('stat-running-jobs').textContent = data.jobs?.running ?? 0;
      document.getElementById('stat-total-jobs').textContent = `Total jobs: ${data.jobs?.total ?? 0}`;
      document.getElementById('stat-active-sessions').textContent = data.sessions?.active ?? 0;
      document.getElementById('stat-total-sessions').textContent = `Total sessions: ${data.sessions?.total ?? 0}`;

      const uptimeSec = data.uptimeSeconds ?? 0;
      document.getElementById('stat-uptime').textContent = formatDuration(uptimeSec);

      if (data.pool) {
        document.getElementById('stat-db-pool').textContent = `${data.pool.totalCount ?? 0} conns`;
        document.getElementById('stat-db-pool-sub').textContent = `Idle: ${data.pool.idleCount ?? 0} | Waiting: ${data.pool.waitingCount ?? 0}`;
      } else {
        document.getElementById('stat-db-pool').textContent = 'In-Memory';
        document.getElementById('stat-db-pool-sub').textContent = 'No database pool';
      }

      // Load recent jobs
      const jobsRes = await apiFetch('/v1/admin/jobs?limit=10');
      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        renderOverviewRecentJobs(jobsData.items || []);
      }
    } catch (e) {
      console.error('Failed to load overview:', e);
    }
  }

  function renderOverviewRecentJobs(jobs) {
    const tbody = document.getElementById('overview-recent-jobs');
    if (jobs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">No recent jobs found.</td></tr>';
      return;
    }
    tbody.innerHTML = jobs.map((job) => `
      <tr>
        <td class="mono">${escapeHtml(job.id)}</td>
        <td>${escapeHtml(job.executionMode || 'ephemeral')}</td>
        <td>${escapeHtml((job.tenantId || '-') + ' / ' + (job.projectId || '-'))}</td>
        <td><span class="pill pill-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span></td>
        <td>${formatTime(job.createdAt)}</td>
        <td>
          <button onclick="window.partnersConsole.openJobStream('${escapeHtml(job.id)}')">Logs</button>
          ${job.state === 'running' || job.state === 'queued' ? `
            <button class="danger" onclick="window.partnersConsole.confirmCancelJob('${escapeHtml(job.id)}')">Cancel</button>
          ` : ''}
        </td>
      </tr>
    `).join('');
  }

  // 2. Audit Records Tab
  async function loadAuditRecords() {
    const tbody = document.getElementById('audit-table-body');
    try {
      const outcome = auditOutcomeFilter.value;
      const actor = auditActorFilter.value.trim();
      let query = '/v1/admin/audit-records?limit=50';
      if (outcome) query += `&outcome=${encodeURIComponent(outcome)}`;
      if (actor) query += `&actor=${encodeURIComponent(actor)}`;

      const res = await apiFetch(query);
      if (res.status === 401 || res.status === 403) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--danger);">Authorization required (admin:read). Click Settings to enter token.</td></tr>`;
        return;
      }
      const data = await res.json();
      const records = data.items || [];

      if (records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No audit records found.</td></tr>';
        return;
      }

      tbody.innerHTML = records.map((r) => `
        <tr>
          <td>${formatTime(r.at)}</td>
          <td><code>${escapeHtml(r.action || '-')}</code></td>
          <td><span class="pill pill-${escapeHtml(r.outcome)}">${escapeHtml(r.outcome)}</span></td>
          <td><code>${escapeHtml(r.scope || '-')}</code></td>
          <td>${escapeHtml(r.actor || '-')}</td>
          <td class="mono">${escapeHtml(r.tokenRef || '-')}</td>
          <td style="color: ${r.outcome === 'denied' ? 'var(--danger)' : 'var(--text-muted)'};">${escapeHtml(r.reason || '-')}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--danger);">Failed to load audit records: ${err.message}</td></tr>`;
    }
  }

  // 3. Jobs Tab
  async function loadJobs() {
    const tbody = document.getElementById('jobs-table-body');
    try {
      const stateFilter = jobsStateFilter.value;
      const tenant = jobsTenantFilter.value.trim();
      let query = '/v1/admin/jobs?limit=50';
      if (stateFilter) query += `&state=${encodeURIComponent(stateFilter)}`;
      if (tenant) query += `&tenantId=${encodeURIComponent(tenant)}`;

      const res = await apiFetch(query);
      if (res.status === 401 || res.status === 403) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--danger);">Authorization required (admin:read). Click Settings to enter token.</td></tr>`;
        return;
      }
      const data = await res.json();
      const jobs = data.items || [];

      if (jobs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No jobs found.</td></tr>';
        return;
      }

      tbody.innerHTML = jobs.map((job) => `
        <tr>
          <td class="mono">${escapeHtml(job.id)}</td>
          <td><span class="pill pill-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span></td>
          <td>${escapeHtml(job.executionMode || '-')}</td>
          <td>${escapeHtml((job.tenantId || '-') + ' / ' + (job.projectId || '-'))}</td>
          <td>${job.exitCode !== null && job.exitCode !== undefined ? codeTag(job.exitCode) : '-'}</td>
          <td>${formatTime(job.createdAt)}</td>
          <td>
            <button onclick="window.partnersConsole.openJobStream('${escapeHtml(job.id)}')">Live Logs</button>
            ${job.state === 'running' || job.state === 'queued' ? `
              <button class="danger" onclick="window.partnersConsole.confirmCancelJob('${escapeHtml(job.id)}')">Cancel</button>
            ` : ''}
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--danger);">Failed to load jobs: ${err.message}</td></tr>`;
    }
  }

  // 4. Sessions Tab
  async function loadSessions() {
    const tbody = document.getElementById('sessions-table-body');
    try {
      const stateFilter = sessionsStateFilter.value;
      let query = '/v1/admin/sessions?limit=50';
      if (stateFilter) query += `&state=${encodeURIComponent(stateFilter)}`;

      const res = await apiFetch(query);
      if (res.status === 401 || res.status === 403) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Authorization required (admin:read). Click Settings to enter token.</td></tr>`;
        return;
      }
      const data = await res.json();
      const sessions = data.items || [];

      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">No workspace sessions found.</td></tr>';
        return;
      }

      tbody.innerHTML = sessions.map((s) => `
        <tr>
          <td class="mono">${escapeHtml(s.id)}</td>
          <td><span class="pill pill-${escapeHtml(s.state)}">${escapeHtml(s.state)}</span></td>
          <td>${escapeHtml(s.provider || '-')}</td>
          <td>${escapeHtml((s.tenantId || '-') + ' / ' + (s.projectId || '-'))}</td>
          <td>${formatTime(s.createdAt)}</td>
          <td style="display:flex; gap:0.25rem; flex-wrap:wrap;">
            <button onclick="window.partnersConsole.openSessionWorkspace('${escapeHtml(s.id)}')">Files</button>
            <button onclick="window.partnersConsole.openTerminal('${escapeHtml(s.id)}')">Terminal</button>
            <button onclick="window.partnersConsole.openSnapshotModal('${escapeHtml(s.id)}')">Snapshot</button>
            <button onclick="window.partnersConsole.promptPreview('${escapeHtml(s.id)}')">Preview</button>
            ${s.state === 'ready' || s.state === 'busy' ? `
              <button class="danger" onclick="window.partnersConsole.confirmStopSession('${escapeHtml(s.id)}')">Stop</button>
            ` : ''}
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Failed to load sessions: ${err.message}</td></tr>`;
    }
  }

  // 5. Idempotency Tab
  async function loadIdempotencyKeys() {
    const tbody = document.getElementById('idempotency-table-body');
    try {
      const res = await apiFetch('/v1/admin/idempotency-keys?limit=50');
      if (res.status === 401 || res.status === 403) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Authorization required (admin:read). Click Settings to enter token.</td></tr>`;
        return;
      }
      const data = await res.json();
      const items = data.items || [];

      if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">No idempotency records recorded.</td></tr>';
        return;
      }

      tbody.innerHTML = items.map((k) => `
        <tr>
          <td class="mono">${escapeHtml(k.key || '-')}</td>
          <td>${escapeHtml(k.tenantId || '-')}</td>
          <td><code>${escapeHtml(k.scope || '-')}</code></td>
          <td class="mono">${escapeHtml((k.requestHash || '-').slice(0, 16))}...</td>
          <td class="mono">${escapeHtml(k.resourceId || '-')}</td>
          <td>${formatTime(k.createdAt)}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Failed to load idempotency keys: ${err.message}</td></tr>`;
    }
  }

  // SSE Live Log Streaming
  function openJobStream(jobId) {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }

    modalJobId.textContent = jobId;
    terminalOutput.innerHTML = `<div class="log-entry log-system">[Connecting to job event feed...]</div>`;
    jobModal.classList.add('active');

    const streamUrl = `${state.gatewayUrl.replace(/\/+$/, '')}/v1/jobs/${encodeURIComponent(jobId)}/events`;
    // Note: native EventSource cannot send custom headers easily, so we pass token in URL if gateway supports,
    // or if using /api/proxy with cookie/header. Let's create an EventSource or fetch reader.
    startStreamReader(streamUrl);
  }

  async function startStreamReader(url) {
    try {
      const headers = {};
      if (state.adminToken) {
        headers['Authorization'] = `Bearer ${state.adminToken}`;
      }
      const response = await fetch(url, { headers });
      if (!response.ok) {
        terminalOutput.innerHTML += `<div class="log-entry log-stderr">Failed to connect: HTTP ${response.status}</div>`;
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          terminalOutput.innerHTML += `<div class="log-entry log-system">[Stream closed by gateway]</div>`;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop();

        for (const block of lines) {
          parseSseBlock(block);
        }
      }
    } catch (err) {
      terminalOutput.innerHTML += `<div class="log-entry log-stderr">Stream error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function parseSseBlock(block) {
    const lines = block.split('\n');
    let eventType = 'message';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      }
    }

    if (!data) return;

    try {
      const parsed = JSON.parse(data);
      appendLogEvent(eventType, parsed);
    } catch {
      appendLogLine('system', data);
    }
  }

  function appendLogEvent(type, event) {
    const time = event.at ? `[${new Date(event.at).toLocaleTimeString()}] ` : '';
    if (type === 'job.state') {
      appendLogLine('system', `${time}State -> ${event.state} ${event.reason ? '(' + event.reason + ')' : ''}`);
    } else if (type === 'job.stdout' || event.stdout) {
      appendLogLine('stdout', event.stdout || event.text || JSON.stringify(event));
    } else if (type === 'job.stderr' || event.stderr) {
      appendLogLine('stderr', event.stderr || event.error || JSON.stringify(event));
    } else if (type === 'artifact.created') {
      appendLogLine('artifact', `${time}Artifact created: ${event.artifact?.name || 'artifact'} (${event.artifact?.sizeBytes || 0} bytes)`);
    } else if (type === 'job.final') {
      appendLogLine('system', `${time}Job finished with state: ${event.state}, exitCode: ${event.exitCode}`);
    } else {
      appendLogLine('stdout', `${time}${JSON.stringify(event)}`);
    }
  }

  function appendLogLine(type, text) {
    const div = document.createElement('div');
    div.className = `log-entry log-${type}`;
    div.textContent = text;
    terminalOutput.appendChild(div);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  // Emergency Actions
  function confirmCancelJob(jobId) {
    confirmTitle.textContent = 'Emergency Cancel Job';
    confirmMessage.textContent = `Are you sure you want to forcibly cancel job ${jobId}? This action sends cancel_requested to the sandbox provider.`;
    state.pendingAction = async () => {
      const res = await apiFetch(`/v1/admin/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Admin Console Emergency Cancel' }),
      });
      if (res.ok) {
        alert(`Job ${jobId} cancellation requested.`);
      } else {
        const err = await res.json();
        alert(`Cancel failed: ${err.error || res.statusText}`);
      }
    };
    confirmModal.classList.add('active');
  }

  function confirmStopSession(sessionId) {
    confirmTitle.textContent = 'Emergency Stop Session';
    confirmMessage.textContent = `Are you sure you want to stop workspace session ${sessionId}?`;
    state.pendingAction = async () => {
      const res = await apiFetch(`/v1/admin/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: 'POST',
      });
      if (res.ok) {
        alert(`Session ${sessionId} stopped.`);
      } else {
        const err = await res.json();
        alert(`Stop session failed: ${err.error || res.statusText}`);
      }
    };
    confirmModal.classList.add('active');
  }

  function startAutoRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      refreshCurrentView();
    }, 10000);
  }

  // Helpers
  function formatTime(iso) {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return iso;
    }
  }

  function formatDuration(sec) {
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    if (min < 60) return `${min}m ${s}s`;
    const hrs = Math.floor(min / 60);
    const m = min % 60;
    return `${hrs}h ${m}m`;
  }

  function codeTag(code) {
    const isZero = code === 0;
    return `<span class="pill ${isZero ? 'pill-succeeded' : 'pill-failed'}">${code}</span>`;
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str ?? '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function debounce(fn, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function showAuthWarning(msg) {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Auth Required (Click Settings)';
  }

  // Workspace File Manager Logic
  let activeWorkspaceSessionId = null;
  let activeSelectedFilePath = null;

  const workspaceModal = document.getElementById('workspace-modal');
  const closeWorkspaceModal = document.getElementById('close-workspace-modal');
  const closeWorkspaceModalBtn = document.getElementById('close-workspace-modal-btn');
  const modalSessionId = document.getElementById('modal-session-id');
  const wsTreeContainer = document.getElementById('ws-tree-container');
  const wsActiveFilename = document.getElementById('ws-active-filename');
  const wsFileActions = document.getElementById('ws-file-actions');
  const wsFileContent = document.getElementById('ws-file-content');
  const wsSensitiveBadge = document.getElementById('ws-sensitive-badge');
  const wsDownloadSingleBtn = document.getElementById('ws-download-single-btn');
  const wsDownloadArchiveBtn = document.getElementById('ws-download-archive-btn');
  const wsRefreshBtn = document.getElementById('ws-refresh-btn');

  function openSessionWorkspace(sessionId) {
    activeWorkspaceSessionId = sessionId;
    activeSelectedFilePath = null;
    modalSessionId.textContent = sessionId;
    wsActiveFilename.textContent = 'Select a file to preview';
    wsFileActions.style.display = 'none';
    wsSensitiveBadge.style.display = 'none';
    wsFileContent.textContent = 'Select a file from the explorer on the left.';
    workspaceModal.classList.add('open');
    loadWorkspaceTree();
  }

  function closeWorkspace() {
    workspaceModal.classList.remove('open');
    activeWorkspaceSessionId = null;
    activeSelectedFilePath = null;
  }

  closeWorkspaceModal.addEventListener('click', closeWorkspace);
  closeWorkspaceModalBtn.addEventListener('click', closeWorkspace);
  wsRefreshBtn.addEventListener('click', loadWorkspaceTree);

  wsDownloadArchiveBtn.addEventListener('click', () => {
    if (!activeWorkspaceSessionId) return;
    const downloadUrl = `${config.gatewayUrl}/v1/sessions/${encodeURIComponent(activeWorkspaceSessionId)}/workspace/download`;
    window.open(downloadUrl, '_blank');
  });

  wsDownloadSingleBtn.addEventListener('click', () => {
    if (!activeWorkspaceSessionId || !activeSelectedFilePath) return;
    const downloadUrl = `${config.gatewayUrl}/v1/sessions/${encodeURIComponent(activeWorkspaceSessionId)}/workspace/download?path=${encodeURIComponent(activeSelectedFilePath)}`;
    window.open(downloadUrl, '_blank');
  });

  async function loadWorkspaceTree() {
    if (!activeWorkspaceSessionId) return;
    wsTreeContainer.innerHTML = 'Loading tree...';
    try {
      const res = await apiFetch(`/v1/sessions/${encodeURIComponent(activeWorkspaceSessionId)}/workspace/tree`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        wsTreeContainer.innerHTML = `<span style="color:var(--danger)">Error: ${err.error || res.statusText}</span>`;
        return;
      }
      const data = await res.json();
      wsTreeContainer.innerHTML = '';
      if (!data.entries || data.entries.length === 0) {
        wsTreeContainer.innerHTML = '<span style="color:var(--text-muted)">Empty workspace</span>';
        return;
      }
      renderTreeEntries(data.entries, wsTreeContainer);
    } catch (err) {
      wsTreeContainer.innerHTML = `<span style="color:var(--danger)">Failed to load tree: ${err.message}</span>`;
    }
  }

  function renderTreeEntries(entries, container) {
    for (const entry of entries) {
      const node = document.createElement('div');
      node.className = 'tree-node';
      if (entry.isSensitive) {
        node.classList.add('tree-node-sensitive');
      }

      const icon = document.createElement('span');
      icon.className = 'tree-node-icon';
      icon.textContent = entry.type === 'directory' ? '📁' : '📄';

      const name = document.createElement('span');
      name.className = 'tree-node-name';
      name.textContent = entry.name;
      if (entry.isSensitive) {
        name.title = 'Sensitive credential / secret file (redacted on preview)';
      }

      node.appendChild(icon);
      node.appendChild(name);
      container.appendChild(node);

      if (entry.type === 'directory' && entry.children) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        renderTreeEntries(entry.children, childrenContainer);
        container.appendChild(childrenContainer);

        node.addEventListener('click', () => {
          childrenContainer.style.display = childrenContainer.style.display === 'none' ? 'block' : 'none';
        });
      } else if (entry.type === 'file') {
        node.addEventListener('click', () => {
          document.querySelectorAll('.tree-node.active').forEach((n) => n.classList.remove('active'));
          node.classList.add('active');
          selectWorkspaceFile(entry.path, entry.isSensitive);
        });
      }
    }
  }

  async function selectWorkspaceFile(filePath, isSensitive) {
    activeSelectedFilePath = filePath;
    wsActiveFilename.textContent = filePath;
    wsFileActions.style.display = 'flex';
    wsSensitiveBadge.style.display = isSensitive ? 'inline-block' : 'none';
    wsFileContent.textContent = 'Loading file content...';

    try {
      const res = await apiFetch(`/v1/sessions/${encodeURIComponent(activeWorkspaceSessionId)}/workspace/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        wsFileContent.textContent = `Error loading file: ${err.error || res.statusText}`;
        return;
      }
      const data = await res.json();
      wsFileContent.textContent = data.content || '(empty file)';
      if (data.isTruncated) {
        wsFileContent.textContent += `\n\n--- Truncated: showing first ${data.previewBytes} bytes of ${data.sizeBytes} bytes total ---`;
      }
    } catch (err) {
      wsFileContent.textContent = `Failed to fetch file: ${err.message}`;
    }
  }

  // 6. Templates and Snapshots Tab
  async function loadTemplatesAndSnapshots() {
    await Promise.all([loadTemplates(), loadSnapshots()]);
  }

  async function loadTemplates() {
    const tbody = document.getElementById('templates-table-body');
    try {
      const res = await apiFetch('/v1/templates');
      if (!res.ok) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--danger);">Failed to load templates.</td></tr>';
        return;
      }
      const data = await res.json();
      const templates = data.items || [];
      if (templates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">No reusable templates registered yet.</td></tr>';
        return;
      }
      tbody.innerHTML = templates.map((t) => `
        <tr>
          <td class="mono">${escapeHtml(t.id)}</td>
          <td><strong>${escapeHtml(t.name)}</strong></td>
          <td class="mono">${escapeHtml(t.snapshotId)}</td>
          <td>${escapeHtml(t.description || '-')}</td>
          <td>${formatTime(t.createdAt)}</td>
          <td>
            <button class="primary" onclick="window.partnersConsole.spawnFromTemplate('${escapeHtml(t.id)}')">Launch Session</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">${err.message}</td></tr>`;
    }
  }

  async function loadSnapshots() {
    const tbody = document.getElementById('snapshots-table-body');
    try {
      const res = await apiFetch('/v1/snapshots');
      if (!res.ok) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--danger);">Failed to load snapshots.</td></tr>';
        return;
      }
      const data = await res.json();
      const snapshots = data.items || [];
      if (snapshots.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">No snapshots captured yet.</td></tr>';
        return;
      }
      tbody.innerHTML = snapshots.map((s) => `
        <tr>
          <td class="mono">${escapeHtml(s.id)}</td>
          <td><span class="badge badge-infra">${escapeHtml(s.label || 'default')}</span></td>
          <td class="mono">${escapeHtml(s.sessionId || '-')}</td>
          <td>${escapeHtml(s.provider || '-')}</td>
          <td>${formatTime(s.createdAt)}</td>
          <td>
            <button onclick="window.partnersConsole.openTemplateModal('${escapeHtml(s.id)}')">Save as Template</button>
            <button class="primary" onclick="window.partnersConsole.spawnFromSnapshot('${escapeHtml(s.id)}')">Restore</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">${err.message}</td></tr>`;
    }
  }

  // Interactive PTY Terminal Logic
  async function openTerminal(sessionId) {
    ptySessionId.textContent = sessionId;
    ptyStatusBadge.textContent = 'Connecting...';
    ptyStatusBadge.className = 'badge badge-infra';
    ptyTerminalOutput.innerHTML = `Connecting to PTY for session ${escapeHtml(sessionId)}...\n`;
    terminalModal.classList.add('active');

    try {
      const initRes = await apiFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/pty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: '/bin/sh', cols: 80, rows: 24 }),
      });
      if (!initRes.ok) {
        ptyTerminalOutput.innerHTML += `\nFailed to initialize PTY: HTTP ${initRes.status}\n`;
        return;
      }
      const ptyInfo = await initRes.json();

      // Determine WebSocket URL
      const host = window.location.host;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${host}/v1/sessions/${encodeURIComponent(sessionId)}/pty`;

      if (activePtyWebSocket) {
        activePtyWebSocket.close();
      }

      activePtyWebSocket = new WebSocket(wsUrl);

      activePtyWebSocket.onopen = () => {
        ptyStatusBadge.textContent = 'Connected';
        ptyStatusBadge.className = 'badge';
        ptyStatusBadge.style.backgroundColor = 'rgba(34, 197, 94, 0.2)';
        ptyStatusBadge.style.color = 'var(--success)';
        ptyTerminalOutput.innerHTML += `Connected to interactive shell.\n`;
        ptyInput.focus();
      };

      activePtyWebSocket.onmessage = (event) => {
        ptyTerminalOutput.innerHTML += escapeHtml(event.data);
        ptyTerminalOutput.scrollTop = ptyTerminalOutput.scrollHeight;
      };

      activePtyWebSocket.onclose = () => {
        ptyStatusBadge.textContent = 'Disconnected';
        ptyStatusBadge.className = 'badge';
        ptyStatusBadge.style.backgroundColor = 'rgba(239, 68, 68, 0.2)';
        ptyStatusBadge.style.color = 'var(--danger)';
        ptyTerminalOutput.innerHTML += `\n[Session connection closed]\n`;
      };

      activePtyWebSocket.onerror = (err) => {
        ptyTerminalOutput.innerHTML += `\n[WebSocket error]\n`;
      };
    } catch (err) {
      ptyTerminalOutput.innerHTML += `\nError: ${err.message}\n`;
    }
  }

  function sendPtyInput() {
    const text = ptyInput.value;
    if (!text || !activePtyWebSocket || activePtyWebSocket.readyState !== WebSocket.OPEN) return;
    activePtyWebSocket.send(text + '\n');
    ptyInput.value = '';
  }

  ptySendBtn.addEventListener('click', sendPtyInput);
  ptyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendPtyInput();
  });

  closeTerminalModal.addEventListener('click', () => {
    if (activePtyWebSocket) activePtyWebSocket.close();
    terminalModal.classList.remove('active');
  });
  closeTerminalModalBtn.addEventListener('click', () => {
    if (activePtyWebSocket) activePtyWebSocket.close();
    terminalModal.classList.remove('active');
  });

  // Snapshot Creation Modal Logic
  function openSnapshotModal(sessionId) {
    snapSessionId.value = sessionId;
    snapLabel.value = `checkpoint-${Date.now().toString().slice(-4)}`;
    snapshotModal.classList.add('active');
  }

  closeSnapshotModal.addEventListener('click', () => snapshotModal.classList.remove('active'));
  cancelSnapshotBtn.addEventListener('click', () => snapshotModal.classList.remove('active'));

  submitSnapshotBtn.addEventListener('click', async () => {
    const sessionId = snapSessionId.value;
    const label = snapLabel.value.trim() || 'default';
    submitSnapshotBtn.disabled = true;
    submitSnapshotBtn.textContent = 'Capturing...';
    try {
      const res = await apiFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        alert('Failed to capture snapshot: ' + (await res.text()));
        return;
      }
      snapshotModal.classList.remove('active');
      switchTab('templates');
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      submitSnapshotBtn.disabled = false;
      submitSnapshotBtn.textContent = 'Capture Snapshot';
    }
  });

  // Template Creation Modal Logic
  function openTemplateModal(snapshotId) {
    tplSnapshotId.value = snapshotId;
    tplName.value = '';
    tplDesc.value = '';
    templateModal.classList.add('active');
  }

  closeTemplateModal.addEventListener('click', () => templateModal.classList.remove('active'));
  cancelTemplateBtn.addEventListener('click', () => templateModal.classList.remove('active'));

  submitTemplateBtn.addEventListener('click', async () => {
    const snapshotId = tplSnapshotId.value;
    const name = tplName.value.trim();
    const description = tplDesc.value.trim();
    if (!name) {
      alert('Template name is required');
      return;
    }
    submitTemplateBtn.disabled = true;
    submitTemplateBtn.textContent = 'Saving...';
    try {
      const res = await apiFetch('/v1/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId, name, description }),
      });
      if (!res.ok) {
        alert('Failed to create template: ' + (await res.text()));
        return;
      }
      templateModal.classList.remove('active');
      loadTemplates();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      submitTemplateBtn.disabled = false;
      submitTemplateBtn.textContent = 'Save Template';
    }
  });

  async function spawnFromTemplate(templateId) {
    if (!confirm(`Launch a new session from template ${templateId}?`)) return;
    try {
      const res = await apiFetch('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId }),
      });
      if (!res.ok) {
        alert('Failed to launch session: ' + (await res.text()));
        return;
      }
      const data = await res.json();
      alert(`Session ${data.id} launched successfully from template!`);
      switchTab('sessions');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function spawnFromSnapshot(snapshotId) {
    if (!confirm(`Restore a new session from snapshot ${snapshotId}?`)) return;
    try {
      const res = await apiFetch('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId }),
      });
      if (!res.ok) {
        alert('Failed to restore session: ' + (await res.text()));
        return;
      }
      const data = await res.json();
      alert(`Session ${data.id} restored successfully from snapshot!`);
      switchTab('sessions');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  // Web Preview Modal Logic
  function promptPreview(sessionId) {
    const port = prompt(`Enter preview port inside session ${sessionId} (e.g. 3000, 5173, 8080):`, '3000');
    if (!port) return;
    openPreview(sessionId, port);
  }

  function openPreview(sessionId, port) {
    const previewUrl = `/preview/${encodeURIComponent(sessionId)}/${encodeURIComponent(port)}/`;
    previewTitle.textContent = `${sessionId} (port ${port})`;
    previewOpenExtLink.href = previewUrl;
    previewIframe.src = previewUrl;
    previewModal.classList.add('active');
  }

  closePreviewModal.addEventListener('click', () => {
    previewIframe.src = 'about:blank';
    previewModal.classList.remove('active');
  });
  closePreviewModalBtn.addEventListener('click', () => {
    previewIframe.src = 'about:blank';
    previewModal.classList.remove('active');
  });

  // Export to window for inline onclick handlers
  window.partnersConsole = {
    openJobStream,
    confirmCancelJob,
    confirmStopSession,
    openSessionWorkspace,
    openTerminal,
    openSnapshotModal,
    openTemplateModal,
    spawnFromTemplate,
    spawnFromSnapshot,
    promptPreview,
    openPreview,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
