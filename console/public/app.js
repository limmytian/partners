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
          <td>
            <button onclick="window.partnersConsole.openSessionWorkspace('${escapeHtml(s.id)}')">Files</button>
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

  // Export to window for inline onclick handlers
  window.partnersConsole = {
    openJobStream,
    confirmCancelJob,
    confirmStopSession,
    openSessionWorkspace,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
