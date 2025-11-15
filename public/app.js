(() => {
  const $ = (id) => document.getElementById(id);
  let authenticated = false;
  let allowPublicViewing = true;
  
  // Check authentication status on load
  function checkAuth() {
    return fetch('/api/auth').then(r => r.json()).then(data => {
      authenticated = data.authenticated;
      allowPublicViewing = data.allowPublicViewing;
      updateUI();
      return authenticated;
    });
  }
  
  // Show/hide login form and controls
  function updateUI() {
    const loginDiv = $('loginDiv');
    const controlsDiv = $('controlsDiv');
    const logoutBtn = $('logoutBtn');
    const authStatus = $('authStatus');
    const loginHint = $('loginHint');
    
    if (authenticated) {
      if (loginDiv) loginDiv.style.display = 'none';
      if (controlsDiv) controlsDiv.style.display = 'block';
      if (logoutBtn) logoutBtn.style.display = 'inline-block';
      if (authStatus) authStatus.textContent = '✓ Authenticated';
      if (loginHint) loginHint.style.display = 'none';
      // Enable all controls
      const buttons = document.querySelectorAll('#controlsDiv button:not(#logoutBtn), #controlsDiv input[type="range"]');
      buttons.forEach(btn => {
        btn.disabled = false;
        btn.style.opacity = '1';
      });
    } else {
      if (loginDiv) loginDiv.style.display = 'block';
      if (controlsDiv) controlsDiv.style.display = allowPublicViewing ? 'block' : 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (authStatus) authStatus.textContent = allowPublicViewing ? 'Viewing only (not authenticated)' : 'Not authenticated';
      if (loginHint) loginHint.style.display = 'inline';
      // Disable control buttons (but keep video visible if public viewing is allowed)
      const controlButtons = document.querySelectorAll('#controlsDiv button:not(#logoutBtn), #controlsDiv input[type="range"]');
      controlButtons.forEach(btn => {
        btn.disabled = true;
        btn.style.opacity = '0.5';
      });
    }
  }
  
  // Login function
  function login(password) {
    return fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    }).then(r => {
      if (r.ok) {
        return checkAuth();
      } else {
        return r.json().then(data => {
          throw new Error(data.error || 'Login failed');
        });
      }
    });
  }
  
  // Logout function
  function logout() {
    return fetch('/api/logout', { method: 'POST' }).then(() => {
      authenticated = false;
      updateUI();
    });
  }
  
  // Setup login form
  const loginForm = $('loginForm');
  const passwordInput = $('passwordInput');
  const loginError = $('loginError');
  const logoutBtn = $('logoutBtn');
  
  if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const password = passwordInput.value;
      login(password).then(() => {
        if (loginError) loginError.textContent = '';
        if (passwordInput) passwordInput.value = '';
      }).catch(err => {
        if (loginError) loginError.textContent = err.message || 'Invalid password';
      });
    });
  }
  
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      logout();
    });
  }
  
  const speedEl = $('speed');
  let speed = speedEl ? parseFloat(speedEl.value) : 0.1;
  if (speedEl) speedEl.addEventListener('input', () => speed = parseFloat(speedEl.value));

  function post(path, obj) {
    return fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj)}).then(r => {
      if (r.status === 401) {
        authenticated = false;
        updateUI();
        throw new Error('Unauthorized - please log in');
      }
      return r.json();
    });
  }

  function move(d) {
    if (!authenticated) {
      console.log('Not authenticated - controls disabled');
      return Promise.resolve();
    }
    return post('/api/move', d).then(updateState).catch(err => {
      console.error('Move error:', err);
      if (err.message.includes('Unauthorized')) {
        if (loginError) loginError.textContent = 'Session expired - please log in again';
      }
    });
  }

  $('up').addEventListener('click', () => move({dy: speed}));
  $('down').addEventListener('click', () => move({dy: -speed}));
  $('forward').addEventListener('click', () => move({dz: -speed}));
  $('back').addEventListener('click', () => move({dz: speed}));
  $('left').addEventListener('click', () => move({dx: -speed}));
  $('right').addEventListener('click', () => move({dx: speed}));
  $('yawLeft').addEventListener('click', () => move({dyaw: -5}));
  $('yawRight').addEventListener('click', () => move({dyaw: 5}));
  $('pitchUp').addEventListener('click', () => move({dpitch: -5}));
  $('pitchDown').addEventListener('click', () => move({dpitch: 5}));

  function updateState(resp) {
    const d = resp.state;
    $('state').innerText = `x:${d.x.toFixed(2)} y:${d.y.toFixed(2)} z:${d.z.toFixed(2)} yaw:${d.yaw.toFixed(1)} pitch:${d.pitch.toFixed(1)} fov:${d.fov.toFixed(1)}`;
  }

  // keyboard controls
  const KEY = {
    ArrowUp: 'forward',
    ArrowDown: 'back',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'forward', s: 'back', a: 'left', d: 'right',
  };

  window.addEventListener('keydown', (ev) => {
    // Don't capture keys when user is typing in input fields
    const activeElement = document.activeElement;
    const isInputFocused = activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.isContentEditable
    );
    
    // If user is typing in an input field, don't handle the key
    if (isInputFocused) {
      return;
    }
    
    // Only handle keys if authenticated
    if (!authenticated) {
      return;
    }
    
    if (ev.key === 'q') { move({dyaw: -5}); ev.preventDefault(); }
    else if (ev.key === 'e') { move({dyaw: 5}); ev.preventDefault(); }
    else if (ev.key === 'r') { move({dy: speed}); ev.preventDefault(); }
    else if (ev.key === 'f') { move({dy: -speed}); ev.preventDefault(); }
    else if (KEY[ev.key]) { const k = KEY[ev.key]; if (k==='forward') move({dz:-speed}); if (k==='back') move({dz:speed}); if (k==='left') move({dx:-speed}); if (k==='right') move({dx:speed}); ev.preventDefault(); }
  });

  // Initialize: check auth and poll initial state
  checkAuth().then(() => {
    fetch('/api/state').then(r=>r.json()).then(d=>{ updateState(d); });
  });

  // Spout stream is now handled directly by the <img> src attribute pointing to /api/spout
  // which proxies to the MJPEG stream from spout-bridge.js

})();
