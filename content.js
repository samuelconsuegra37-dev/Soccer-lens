/**
 * Soccer Lens Content Script
 *
 * Injected into every page (per manifest.json). Watches for <video>
 * elements, captures the current frame whenever one is paused, and
 * sends it to the local FastAPI backend for player identification.
 * Renders all overlay UI (loading state, stats panel, multi-player
 * selector) directly into the page's DOM.
 *
 * Talks to the backend via direct fetch() calls to localhost:8000.
 * An earlier version relayed requests through background.js using
 * chrome.runtime.sendMessage, but that approach proved unreliable
 * inside YouTube's content script context — background.js has since
 * been removed.
 */

console.log('Soccer Lens loaded');

// ---------------------------------------------------------------------
// Video lifecycle
// ---------------------------------------------------------------------

/**
 * Attaches pause/play listeners to every <video> element on the page
 * that hasn't already been wired up. Re-run on an interval (see
 * setInterval below) because YouTube replaces its video element when
 * navigating between videos, which would otherwise leave new videos
 * unlistened.
 */
function setupVideoListeners() {
  const videos = document.querySelectorAll('video');
  videos.forEach(video => {
    if (video.dataset.soccerLens) return; // already wired up
    video.dataset.soccerLens = 'true';

    video.addEventListener('pause', () => {
      console.log('Video paused - capturing frame...');
      captureAndIdentify(video);
    });

    // The multi-player selector's bounding boxes are tied to one
    // frozen frame; once the video resumes, those positions no
    // longer correspond to anything meaningful, so clear it.
    video.addEventListener('play', () => {
      removePlayerSelector();
    });
  });
}

// Catches videos that appear after initial page load
setInterval(setupVideoListeners, 2000);
setupVideoListeners();

// ---------------------------------------------------------------------
// Frame capture & identification
// ---------------------------------------------------------------------

/**
 * Captures the current frame of a paused video as a JPEG, uploads it
 * to the backend's /identify endpoint, and routes the response to
 * the appropriate UI state: a single player's overlay, a multi-player
 * selector, or a "no player detected" message.
 *
 * @param {HTMLVideoElement} video - The video element that was paused.
 */
async function captureAndIdentify(video) {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    console.log('Video dimensions not ready, skipping');
    return;
  }

  showLoadingOverlay();

  // Draw the current frame to an off-screen canvas to extract it as
  // a JPEG, since there's no direct way to grab a single frame from
  // a <video> element otherwise.
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg').split(',')[1];

  // Convert the base64 string into a binary Blob so it can be sent
  // as a real file upload (multipart/form-data) rather than text.
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

    if (data.multiple) {
      showPlayerSelector(data.candidates, video);
    } else if (data.name) {
      showOverlay(data);
      fetchNarrative(data.name);
    } else {
      showNoPlayerMessage();
      console.log('No player detected');
    }
  } catch (e) {
    removeLoadingOverlay();
    console.error('Error:', e.message);
  }
}

// ---------------------------------------------------------------------
// Overlay UI states
// ---------------------------------------------------------------------

/**
 * Renders a temporary "IDENTIFYING PLAYER" overlay shown immediately
 * after a pause, while the /identify request is in flight. Replaced
 * by showOverlay(), showNoPlayerMessage(), or showPlayerSelector()
 * once a response arrives.
 */
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

/** Removes the loading overlay, if present. Safe to call even if it isn't showing. */
function removeLoadingOverlay() {
  const existing = document.getElementById('soccer-lens-overlay');
  if (existing) existing.remove();
}

/**
 * Shows a brief "NO PLAYER DETECTED" message, auto-dismissing after
 * 3 seconds. Used when /identify returns no usable result — either
 * no face was found, or every detected face failed the backend's
 * is_soccer_player validation.
 */
function showNoPlayerMessage() {
  const existing = document.getElementById('soccer-lens-overlay');
  if (existing) existing.remove();

  const message = document.createElement('div');
  message.id = 'soccer-lens-overlay';
  message.innerHTML = `
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
      .sl-message-header {
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
      .sl-no-player-text {
        font-size: 8px;
        color: #5599bb;
        line-height: 1.8;
      }
    </style>
    <div class="sl-message-header">
      <span style="color: #00aaff; font-size: 11px; letter-spacing: 4px; text-shadow: 0 0 8px #00aaff, 0 0 16px #00aaff, 0 0 30px #00aaff;">SOCCER LENS</span>
      <span id="sl-close" style="cursor:pointer; font-size:14px; color:#00aaff;">✕</span>
    </div>
    <div class="sl-no-player-text">NO PLAYER DETECTED</div>
  `;

  document.body.appendChild(message);

  document.getElementById('sl-close').addEventListener('click', () => {
    document.getElementById('soccer-lens-overlay').remove();
  });

  setTimeout(() => {
    const el = document.getElementById('soccer-lens-overlay');
    if (el) el.remove();
  }, 3000);
}

/**
 * Renders the main player stats overlay: photo, basic info, AI
 * narrative placeholder (filled in later by fetchNarrative), and a
 * season-by-season stats breakdown split into "priority" leagues
 * (shown by default) and a collapsible "other leagues" section.
 *
 * Also wires up the overlay's drag-to-move behavior (via the header)
 * and the show/hide toggle for non-priority leagues.
 *
 * NOTE: the MIN (minutes played) stat cell below reads
 * `s.minutes_played`, but the backend's stats objects never set this
 * field — only goals, assists, appearances, yellow_cards, and
 * red_cards exist. MIN will always render as 0 until the backend
 * supplies this value.
 *
 * @param {Object} data - Response from /identify or /player/{name}.
 * @param {Object} data.player - The player profile to render.
 */
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

  // Renders one collapsible block per league/season entry.
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

  // Drag-to-move: clicking and holding the header repositions the
  // whole overlay, switching it from right-anchored to left/top-anchored
  // the first time it's dragged.
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

  // Toggles visibility of non-priority leagues
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

// ---------------------------------------------------------------------
// AI narrative
// ---------------------------------------------------------------------

/**
 * Fetches the AI-generated narrative for a player and fills it into
 * the "PLAYER INTEL" section of the currently open overlay. Runs as
 * a separate request from the main stats fetch so the stats panel
 * can render immediately without waiting on the slower Granite call.
 *
 * @param {string} playerName - Full name to request a narrative for.
 */
async function fetchNarrative(playerName) {
  try {
    const response = await fetch(`http://localhost:8000/profile/${encodeURIComponent(playerName)}`);
    const data = await response.json();
    const narrativeEl = document.getElementById('sl-narrative');
    if (narrativeEl && data.narrative) {
      narrativeEl.style.color = '#aaa';
      narrativeEl.textContent = data.narrative;
    }
  } catch (e) {
    console.error('Narrative error:', e.message);
  }
}

// ---------------------------------------------------------------------
// Multi-player selector
// ---------------------------------------------------------------------

/** Removes the multi-player selector overlay and its event listeners, if present. */
function removePlayerSelector() {
  const existing = document.getElementById('soccer-lens-selector');
  if (existing) {
    if (existing._cleanup) existing._cleanup();
    existing.remove();
  }
}

/**
 * Renders a clickable marker over each detected face when /identify
 * returns multiple candidates, letting the user choose which player
 * to look up. Each marker is positioned using the face's bounding box
 * (returned as fractions of the frame, 0–1) scaled against the
 * video's actual on-screen size.
 *
 * Tracks the video's position/size across scrolling, window resizing,
 * and entering/exiting fullscreen — fullscreen specifically requires
 * re-parenting the selector into document.fullscreenElement, since
 * the Fullscreen API renders that element in a special layer that
 * sits above everything outside its own subtree.
 *
 * @param {Array<{name: string, box: Object}>} candidates - Player
 *   names and bounding boxes (AWS Rekognition format: Left, Top,
 *   Width, Height as fractions of the frame).
 * @param {HTMLVideoElement} video - The video element to overlay markers on.
 */
function showPlayerSelector(candidates, video) {
  removeLoadingOverlay();
  removePlayerSelector();

  const container = document.createElement('div');
  container.id = 'soccer-lens-selector';
  container.style.position = 'absolute';
  container.style.zIndex = '999999';
  container.style.pointerEvents = 'none';

  candidates.forEach(c => {
    const box = c.box;
    const marker = document.createElement('div');
    marker.className = 'sl-selector-marker';
    // Store the raw fractions so reposition() can recompute exact
    // pixel coordinates whenever the video's size/position changes.
    marker.dataset.left = box.Left;
    marker.dataset.top = box.Top;
    marker.dataset.width = box.Width;
    marker.dataset.height = box.Height;
    marker.style.position = 'absolute';
    marker.style.border = '2px solid #00aaff';
    marker.style.boxShadow = '0 0 10px #00aaff';
    marker.style.cursor = 'pointer';
    marker.style.pointerEvents = 'auto';

    const tag = document.createElement('div');
    tag.textContent = c.name.toUpperCase();
    tag.style.position = 'absolute';
    tag.style.bottom = '-24px';
    tag.style.left = '0';
    tag.style.background = '#0a0a1a';
    tag.style.border = '1px solid #00aaff';
    tag.style.color = '#00aaff';
    tag.style.fontFamily = "'Press Start 2P', monospace";
    tag.style.fontSize = '7px';
    tag.style.padding = '4px 6px';
    tag.style.whiteSpace = 'nowrap';

    marker.appendChild(tag);
    marker.addEventListener('click', (e) => {
      // Prevents the click from also toggling the video's play/pause state
      e.stopPropagation();
      e.preventDefault();
      selectPlayer(c.name);
    });
    container.appendChild(marker);
  });

  /** Recomputes the selector container's and every marker's position/size. */
  function reposition() {
    const rect = video.getBoundingClientRect();
    const inFullscreen = !!document.fullscreenElement;

    if (inFullscreen) {
      // Inside the fullscreen element, coordinates are already
      // relative to the viewport — no scroll offset needed.
      container.style.top = `${rect.top}px`;
      container.style.left = `${rect.left}px`;
    } else {
      container.style.top = `${rect.top + window.scrollY}px`;
      container.style.left = `${rect.left + window.scrollX}px`;
    }
    container.style.width = `${rect.width}px`;
    container.style.height = `${rect.height}px`;

    container.querySelectorAll('.sl-selector-marker').forEach(marker => {
      marker.style.left = `${parseFloat(marker.dataset.left) * rect.width}px`;
      marker.style.top = `${parseFloat(marker.dataset.top) * rect.height}px`;
      marker.style.width = `${parseFloat(marker.dataset.width) * rect.width}px`;
      marker.style.height = `${parseFloat(marker.dataset.height) * rect.height}px`;
    });
  }

  /** Re-parents the selector into (or out of) the fullscreen element when fullscreen is toggled. */
  function handleFullscreenChange() {
    if (document.fullscreenElement) {
      document.fullscreenElement.appendChild(container);
    } else {
      document.body.appendChild(container);
    }
    reposition();
  }

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  window.addEventListener('scroll', reposition);
  window.addEventListener('resize', reposition);

  // Exposed so removePlayerSelector() can tear down these listeners
  // when the selector is dismissed — otherwise they'd silently pile
  // up across repeated pauses during a session.
  container._cleanup = () => {
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    window.removeEventListener('scroll', reposition);
    window.removeEventListener('resize', reposition);
  };

  document.body.appendChild(container);
  reposition();
}

/**
 * Fetches full profile data for one player chosen from the
 * multi-player selector, then renders the standard stats overlay for
 * them. The selector itself is left untouched so other candidates
 * remain clickable afterward.
 *
 * @param {string} playerName - Name of the selected candidate.
 */
async function selectPlayer(playerName) {
  showLoadingOverlay();
  try {
    const response = await fetch(`http://localhost:8000/player/${encodeURIComponent(playerName)}`);
    const data = await response.json();
    if (data.player) {
      showOverlay(data);
      fetchNarrative(data.name);
    } else {
      showNoPlayerMessage();
    }
  } catch (e) {
    removeLoadingOverlay();
    console.error('Player fetch error:', e.message);
  }
}