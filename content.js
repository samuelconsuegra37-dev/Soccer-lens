console.log('Soccer Lens loaded');

function setupVideoListeners() {
  const videos = document.querySelectorAll('video');
  videos.forEach(video => {
    if (video.dataset.soccerLens) return;
    video.dataset.soccerLens = 'true';
    video.addEventListener('pause', () => {
      console.log('Video paused - capturing frame...');
      captureAndIdentify(video);
    });
  });
}

setInterval(setupVideoListeners, 2000);
setupVideoListeners();

async function captureAndIdentify(video) {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    console.log('Video dimensions not ready, skipping');
    return;
  }

  // Show loading overlay immediately
  showLoadingOverlay();

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg').split(',')[1];

  const byteString = atob(base64);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  const blob = new Blob([ab], { type: 'image/jpeg' });
  const formData = new FormData();
  formData.append('file', blob, 'frame.jpg');

  try {
    const response = await fetch('http://localhost:8000/identify', {
      method: 'POST',
      body: formData
    });
    const data = await response.json();
    console.log('Player identified:', data);
    if (data.name) {
      showOverlay(data);
      fetchNarrative(data.name);
    } else {
      removeLoadingOverlay();
      console.log('No player detected');
    }
  } catch(e) {
    removeLoadingOverlay();
    console.error('Error:', e.message);
  }
}

function showLoadingOverlay() {
  const existing = document.getElementById('soccer-lens-overlay');
  if (existing) existing.remove();

  const loading = document.createElement('div');
  loading.id = 'soccer-lens-overlay';
  loading.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
      #soccer-lens-overlay {
        font-family: 'Press Start 2P', monospace;
        background: #0a0a1a;
        border: 3px solid #00aaff;
        box-shadow: 0 0 0 3px #0a0a1a, 0 0 0 5px #00aaff, 0 0 30px rgba(0, 170, 255, 0.4), 0 0 60px rgba(0, 170, 255, 0.2);
        color: #00aaff;
        width: 400px;
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 99999;
        padding: 20px;
        text-align: center;
      }
      .sl-loading-header {
        background: #0a0a1a;
        color: #00aaff;
        border-bottom: 2px solid #00aaff;
        padding: 8px 12px;
        font-size: 9px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        letter-spacing: 1px;
        margin: -20px -20px 20px -20px;
      }
      @keyframes sl-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      .sl-loading-text {
        font-size: 8px;
        color: #00aaff;
        animation: sl-pulse 1s ease-in-out infinite;
        letter-spacing: 2px;
      }
      .sl-loading-dots {
        font-size: 12px;
        color: #00aaff;
        margin-top: 10px;
        animation: sl-pulse 0.8s ease-in-out infinite;
      }
    </style>
    <div class="sl-loading-header">
      <span style="color: #00aaff; font-size: 11px; letter-spacing: 4px; text-shadow: 0 0 8px #00aaff, 0 0 16px #00aaff, 0 0 30px #00aaff;">SOCCER LENS</span>
      <span id="sl-close" style="cursor:pointer; font-size:14px; color:#00aaff;">✕</span>
    </div>
    <div class="sl-loading-text">IDENTIFYING PLAYER</div>
    <div class="sl-loading-dots">▸ ▸ ▸</div>
  `;

  document.body.appendChild(loading);

  document.getElementById('sl-close').addEventListener('click', () => {
    document.getElementById('soccer-lens-overlay').remove();
  });
}

function removeLoadingOverlay() {
  const existing = document.getElementById('soccer-lens-overlay');
  if (existing) existing.remove();
}

function showOverlay(data) {
  const existing = document.getElementById('soccer-lens-overlay');
  if (existing) existing.remove();
  const player = data.player;
  if (!player) return;

  const stats = player.stats || [];

  const priorityLeagues = [
    'FIFA World Cup', 'MLS', 'Premier League',
    'LaLiga', 'Serie A', 'Bundesliga', 'Ligue 1'
  ];

  const priorityStats = stats.filter(s =>
    priorityLeagues.some(l => s.league.includes(l))
  );

  const otherStats = stats.filter(s =>
    !priorityLeagues.some(l => s.league.includes(l))
  );

  const buildStatRows = (statList) => statList.map(s => `
    <div class="sl-league-block">
      <div class="sl-league-name">▹ ${s.league.toUpperCase()} ${s.season}</div>
      <div class="sl-stat-grid">
        <div class="sl-stat-cell"><span class="sl-lbl">GOL</span><span class="sl-val">${s.goals}</span></div>
        <div class="sl-stat-cell"><span class="sl-lbl">AST</span><span class="sl-val">${s.assists}</span></div>
        <div class="sl-stat-cell"><span class="sl-lbl">APP</span><span class="sl-val">${s.appearances}</span></div>
        <div class="sl-stat-cell"><span class="sl-lbl">MIN</span><span class="sl-val">${s.minutes_played || 0}</span></div>
        <div class="sl-stat-cell"><span class="sl-lbl">YLW</span><span class="sl-val sl-yellow">${s.yellow_cards}</span></div>
        <div class="sl-stat-cell"><span class="sl-lbl">RED</span><span class="sl-val sl-red">${s.red_cards}</span></div>
      </div>
      <div class="sl-divider"></div>
    </div>
  `).join('');

  const otherHTML = otherStats.length > 0 ? `
    <div id="sl-other-stats" style="display:none;">
      ${buildStatRows(otherStats)}
    </div>
    <div id="sl-toggle" class="sl-toggle-btn">▸ SHOW ${otherStats.length} MORE LEAGUES</div>
  ` : '';

  const statsHTML = buildStatRows(priorityStats) + otherHTML;

  const overlay = document.createElement('div');
  overlay.id = 'soccer-lens-overlay';
  overlay.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
      #soccer-lens-overlay {
        font-family: 'Press Start 2P', monospace;
        background: #0a0a1a;
        border: 3px solid #00aaff;
        box-shadow: 0 0 0 3px #0a0a1a, 0 0 0 5px #00aaff, 0 0 30px rgba(0, 170, 255, 0.4), 0 0 60px rgba(0, 170, 255, 0.2);
        color: #00aaff;
        width: 400px;
        max-height: 85vh;
        overflow-y: auto;
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 99999;
        image-rendering: pixelated;
        scrollbar-width: thin;
        scrollbar-color: #00aaff #0a0a1a;
      }
      .sl-scanlines {
        pointer-events: none;
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px);
        z-index: 10;
      }
      .sl-header {
        background: #0a0a1a;
        color: #00aaff;
        border-bottom: 2px solid #00aaff;
        padding: 8px 12px;
        font-size: 9px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        letter-spacing: 1px;
        position: sticky;
        top: 0;
        z-index: 20;
      }
      .sl-player-section {
        display: flex;
        gap: 0;
        padding: 0;
        border-bottom: 2px solid #00aaff;
      }
      .sl-photo {
        width: 110px;
        height: 110px;
        border-right: 2px solid #00aaff;
        background: #111;
        flex-shrink: 0;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 28px;
        color: #00aaff;
      }
      .sl-photo img { width: 100%; height: 100%; object-fit: cover; }
      .sl-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        justify-content: center;
        padding: 12px;
        flex: 1;
      }
      .sl-name { font-size: 9px; color: #fff; line-height: 1.6; }
      .sl-meta { font-size: 7px; color: #00aaff; line-height: 2.2; }
      .sl-meta span { color: #ffcc00; }
      .sl-stats-section { padding: 10px 12px; border-bottom: 2px solid #00aaff; }
      .sl-stats-label { font-size: 6px; color: #ffcc00; margin-bottom: 8px; letter-spacing: 1px; }
      .sl-league-block { margin-bottom: 6px; }
      .sl-league-name { font-size: 7px; color: #00aaff; margin-bottom: 5px; }
      .sl-stat-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
      .sl-stat-cell { text-align: center; }
      .sl-lbl { font-size: 6px; color: #888; display: block; margin-bottom: 2px; }
      .sl-val { font-size: 9px; color: #fff; display: block; }
      .sl-yellow { color: #ffcc00 !important; }
      .sl-red { color: #ff4444 !important; }
      .sl-divider { height: 1px; background: #1a1a2e; margin: 6px 0; }
      .sl-toggle-btn {
        font-size: 6px;
        color: #00aaff;
        cursor: pointer;
        padding: 8px 12px;
        border-top: 1px solid #1a1a2e;
        letter-spacing: 0.5px;
      }
      .sl-toggle-btn:hover { color: #fff; }
      .sl-narrative-section { padding: 10px 12px; }
      .sl-narrative-label { font-size: 6px; color: #ffcc00; margin-bottom: 8px; letter-spacing: 1px; }
      .sl-narrative-text { font-size: 7px; color: #ccc; line-height: 2.2; }
      .sl-loading { font-size: 6px; color: #555; }
      @keyframes sl-fadein { from { opacity: 0; } to { opacity: 1; } }
      #soccer-lens-overlay { animation: sl-fadein 0.3s ease-in; }
    </style>

    <div class="sl-scanlines"></div>

    <div class="sl-header">
      <span style="color: #00aaff; font-size: 13px; letter-spacing: 4px; text-shadow: 0 0 8px #00aaff, 0 0 16px #00aaff, 0 0 30px #00aaff;">SOCCER LENS</span>
      <span id="sl-close" style="cursor:pointer; font-size:14px;">✕</span>
    </div>

    <div class="sl-player-section">
      <div class="sl-photo">
        <img src="${player.photo}" alt="${player.name}" onerror="this.style.display='none'; this.parentNode.innerHTML='👤'"/>
      </div>
      <div class="sl-info">
        <div class="sl-name">${player.name.toUpperCase()}</div>
        <div class="sl-meta">
          NAT: <span>${player.nationality.toUpperCase()}</span><br>
          POS: <span>${player.position}</span><br>
          KIT: <span>#${player.number || '?'}</span><br>
          CLUB: <span>${player.team.toUpperCase()}</span>
        </div>
      </div>
    </div>

    <div class="sl-narrative-section">
      <div class="sl-narrative-label">▸ PLAYER INTEL</div>
      <div class="sl-narrative-text sl-loading" id="sl-narrative">LOADING...</div>
    </div>

    <div style="height: 2px; background: #00aaff; margin: 0;"></div>

    <div class="sl-stats-section">
      <div class="sl-stats-label">▸ SEASON STATS</div>
      ${statsHTML}
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('sl-close').addEventListener('click', () => {
    document.getElementById('soccer-lens-overlay').remove();
  });

  const header = overlay.querySelector('.sl-header');
  let isDragging = false;
  let offsetX, offsetY;

  header.style.cursor = 'grab';

  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'sl-close') return;
    isDragging = true;
    offsetX = e.clientX - overlay.getBoundingClientRect().left;
    offsetY = e.clientY - overlay.getBoundingClientRect().top;
    header.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    overlay.style.right = 'auto';
    overlay.style.left = `${e.clientX - offsetX}px`;
    overlay.style.top = `${e.clientY - offsetY}px`;
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    header.style.cursor = 'grab';
  });

  const toggleBtn = document.getElementById('sl-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const other = document.getElementById('sl-other-stats');
      const isHidden = other.style.display === 'none';
      other.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden
        ? `▾ HIDE EXTRA LEAGUES`
        : `▸ SHOW ${otherStats.length} MORE LEAGUES`;
    });
  }
}

async function fetchNarrative(playerName) {
  try {
    const response = await fetch(`http://localhost:8000/profile/${encodeURIComponent(playerName)}`);
    const data = await response.json();
    const narrativeEl = document.getElementById('sl-narrative');
    if (narrativeEl && data.narrative) {
      narrativeEl.style.color = '#aaa';
      narrativeEl.textContent = data.narrative;
    }
  } catch(e) {
    console.error('Narrative error:', e.message);
  }
}