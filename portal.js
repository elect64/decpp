/* ==========================================================
   DECRYPT 2.0 PARTICIPANT PORTAL — portal.js v3
   v2 foundation preserved: theming, decrypt-rain auth canvas,
   scramble text, sliding nav indicator, bottom nav, tilt,
   ripples, reveal-on-scroll, campaigns, QR, certificate.

   v3 additions (all additive, no API changes):
   UnlockSequence · DecryptPass · SessionLive (Live Now +
   countdown) · DailyDecrypt (playable cipher game) ·
   Progress (XP / Achievements / Journey) · MotionFX toggle ·
   access-code normalization + recovery panel.
   ========================================================== */

/* ---------- CONFIG ---------- */
var API = 'https://script.google.com/macros/s/AKfycbzFFb8ZWPFUdoInKKIcZ9D1mZif2cKwzdxOyfoMqk6z7_xLV3WBUFiHCT7AJZ-g8tTG8A/exec';

/* Banner image path — update to your actual banner file.
   Leave as empty string '' to use the animated CSS fallback. */
var BANNER_IMAGE_URL = 'https://i.ibb.co/8LRPsBGw/dec-pbp.png';

var CAMPAIGN_POLL_INTERVAL = 60000; // ms

/* ==========================================================
   FEATURE FLAGS — isolated future-integration points.
   These gate UI that needs backend data we do not yet have.
   Nothing here fabricates server state.
   ========================================================== */
var DECRYPT_FEATURES = {
  liveSessions: true,     /* reads DECRYPT_SESSIONS below      */
  dailyChallenge: true,   /* local-only persistence, labeled   */
  achievements: true,     /* derived from real participant data */
  passDownload: true      /* canvas-based PNG, best-effort      */
};

/* LIVE SESSIONS — populated by the DECRYPT team as sessions
   are confirmed. Each: { id, title, speaker, description,
   link, startISO, endISO } (event-local time, ISO 8601 with
   offset, e.g. '2026-10-17T19:00:00+01:00').
   Empty array => Home shows a graceful "no session" state.   */
var DECRYPT_SESSIONS = [
  { id: 's1', title: 'Opening Session', speaker: 'DECRYPT Team',
    description: 'Welcome + keynote.',
    link: '', startISO: '2026-10-17T18:00:00+01:00',
    endISO: '2026-10-17T19:30:00+01:00' }
  
];

/* Early-access cutoff for the EARLY ACCESS achievement —
   uses the real registeredAt field from the participant. */
var EARLY_ACCESS_CUTOFF = '2026-10-01T00:00:00';

/* ---------- STATE ---------- */
var SESSION_KEY  = 'dcmd_portal_session';
var CAMPAIGN_KEY = 'dcmd_portal_last_campaign';
var THEME_KEY    = 'dcmd_theme';
var FX_KEY       = 'dcmd_fx';
var XP_KEY       = 'dcmd_xp';
var SEEN_KEY     = 'dcmd_seen_unlock';
var _participant = null;
var _campaignTimer = null;
var _sessionTimer = null;
var _mediaReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var _fxOff = false;
var _reduceMotion = _mediaReduce;
var _finePointer  = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ==========================================================
   UTILITIES
   ========================================================== */
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, 2800);
}

function apiFetch(params) {
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return fetch(API + '?' + qs).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function pill(text, type) {
  return '<span class="pill pill-' + (type || 'neutral') + '"><span class="pill-dot"></span>' + esc(text) + '</span>';
}

/* Text scramble — terminal-style decrypt reveal */
function scramble(el, finalText) {
  if (_reduceMotion || !el) { if (el) el.textContent = finalText; return; }
  var chars = '!<>-_/[]{}=+*^?#ABCDEFGHKMNPQRSTUVWXYZ0123456789';
  var frame = 0;
  var queue = finalText.split('').map(function (ch, i) {
    return { ch: ch, start: i * 1.6 + Math.random() * 6, end: i * 1.6 + 8 + Math.random() * 14 };
  });
  clearInterval(el._scr);
  el._scr = setInterval(function () {
    var out = '', done = 0;
    queue.forEach(function (q) {
      if (frame >= q.end) { done++; out += q.ch; }
      else if (frame >= q.start) { out += chars[(Math.random() * chars.length) | 0]; }
      else { out += q.ch === ' ' ? ' ' : ''; }
    });
    el.textContent = out;
    frame++;
    if (done === queue.length) clearInterval(el._scr);
  }, 28);
}

/* Access-code normalization — forgiving input, strict output.
   Accepts DEC2.O-XXXXX, dec2.o xxxxx, DEC2.OXXXXX etc.
   Always returns the canonical DEC2.O-XXXXX form (or the
   cleaned input unchanged if it doesn't look like a DECRYPT
   code, so error messaging stays accurate). */
function normalizeCode(v) {
  var s = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  var m = s.match(/^DEC2\.?O-?([A-Z0-9]+)$/);
  if (m) return 'DEC2.O-' + m[1];
  return s;
}

/* Visual input state: '' | 'incomplete' | 'valid' | 'invalid' */
function codeState(v) {
  if (!v) return '';
  if (/^DEC2\.O-[A-Z0-9]{5}$/.test(v)) return 'valid';
  if (/^DEC2\.?O?-?[A-Z0-9.]{0,12}$/.test(v)) return 'incomplete';
  return 'invalid';
}

function setCodeState(input, state) {
  input.classList.remove('state-valid', 'state-invalid', 'state-incomplete');
  if (state) input.classList.add('state-' + state);
}

/* Reveal-on-scroll */
var _revealIO = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
  entries.forEach(function (e) {
    if (e.isIntersecting) { e.target.classList.add('in'); _revealIO.unobserve(e.target); }
  });
}, { threshold: 0.1 }) : null;

function observeReveals(scope) {
  var els = (scope || document).querySelectorAll('.reveal:not(.in)');
  for (var i = 0; i < els.length; i++) {
    if (_revealIO) _revealIO.observe(els[i]); else els[i].classList.add('in');
  }
}

/* Click ripple */
document.addEventListener('click', function (e) {
  var b = e.target.closest('.btn-ripple, .auth-btn, .home-quick-item, .bnav-item, .portal-nav-item, .qr-download-btn, .event-join-btn, .cert-download-btn, .theme-toggle, .dd-card, .fx-toggle, .pass-save-btn, .dd-crack-btn, .dd-shift-btn');
  if (!b || _reduceMotion) return;
  var rect = b.getBoundingClientRect();
  var d = Math.max(rect.width, rect.height) * 1.1;
  var r = document.createElement('span');
  r.className = 'ripple';
  r.style.width = r.style.height = d + 'px';
  r.style.left = (e.clientX - rect.left - d / 2) + 'px';
  r.style.top  = (e.clientY - rect.top  - d / 2) + 'px';
  var cs = getComputedStyle(b);
  if (cs.position === 'static') b.style.position = 'relative';
  if (cs.overflow === 'visible') b.style.overflow = 'hidden';
  b.appendChild(r);
  setTimeout(function () { r.remove(); }, 680);
});

/* Subtle 3D tilt on fine pointers */
function bindTilt(el, maxDeg) {
  if (!_finePointer || _reduceMotion || !el) return;
  maxDeg = maxDeg || 7;
  el.addEventListener('pointermove', function (e) {
    var rect = el.getBoundingClientRect();
    var px = (e.clientX - rect.left) / rect.width  - 0.5;
    var py = (e.clientY - rect.top)  / rect.height - 0.5;
    el.style.transform = 'perspective(700px) rotateY(' + (px * maxDeg) + 'deg) rotateX(' + (-py * maxDeg) + 'deg) translateY(-2px)';
    el.style.transition = 'transform 60ms linear';
  });
  el.addEventListener('pointerleave', function () {
    el.style.transform = '';
    el.style.transition = 'transform 420ms cubic-bezier(0.16,1,0.3,1)';
  });
}

/* Modal helpers */
function openModal(id) {
  var m = document.getElementById(id);
  if (!m) return;
  m.classList.add('visible');
  m.setAttribute('aria-hidden', 'false');
}
function closeModal(id) {
  var m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('visible');
  m.setAttribute('aria-hidden', 'true');
}
document.addEventListener('click', function (e) {
  if (e.target.classList && e.target.classList.contains('modal-veil')) {
    closeModal(e.target.id);
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    closeModal('pass-overlay');
    closeModal('dd-modal');
  }
});

/* ==========================================================
   MOTION FX — user-controlled effects preference
   (independent of OS-level prefers-reduced-motion)
   ========================================================== */
var MotionFX = (function () {
  function isOff() { return _fxOff; }

  function apply(off, persist) {
    _fxOff = off;
    _reduceMotion = _mediaReduce || off;
    var root = document.documentElement;
    if (off) root.setAttribute('data-fx', 'off'); else root.removeAttribute('data-fx');
    if (persist !== false) {
      try { off ? localStorage.setItem(FX_KEY, 'off') : localStorage.removeItem(FX_KEY); } catch (e) {}
    }
    /* rain canvas is the only continuous loop — stop it live */
    var veil = document.getElementById('auth-veil');
    var veilVisible = veil && veil.style.display !== 'none';
    if (off) AuthFX.stop();
    else if (veilVisible) AuthFX.start();
    var btn = document.getElementById('fx-toggle');
    if (btn) btn.setAttribute('aria-pressed', off ? 'false' : 'true');
    SessionLive.setFx(!(_reduceMotion)); /* countdown always runs; this gates cosmetic extras */
  }

  function init() {
    var saved = null;
    try { saved = localStorage.getItem(FX_KEY); } catch (e) {}
    apply(saved === 'off', false);
    var btn = document.getElementById('fx-toggle');
    if (btn) btn.addEventListener('click', function () {
      apply(!_fxOff);
      toast(_fxOff ? 'Decrypt effects off' : 'Decrypt effects on');
    });
  }

  return { init: init, isOff: isOff };
})();

/* ==========================================================
   THEME
   ========================================================== */
var Theme = (function () {
  var KEY = THEME_KEY;

  function apply(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#060A07' : '#F4F6EF');
    if (persist !== false) {
      try { localStorage.setItem(KEY, theme); } catch (e) {}
    }
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme } }));
  }

  function init() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    apply(saved || (mq.matches ? 'dark' : 'light'), false);

    mq.addEventListener('change', function (e) {
      var cur = null;
      try { cur = localStorage.getItem(KEY); } catch (err) {}
      if (!cur) apply(e.matches ? 'dark' : 'light', false);
    });

    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(next);
      toast(next === 'dark' ? 'Dark mode on' : 'Light mode on');
    });
  }

  return { init: init, apply: apply };
})();

/* ==========================================================
   AUTH FX — decrypt rain canvas on the brand panel
   ========================================================== */
var AuthFX = (function () {
  var canvas, ctx, cols, drops, raf = null, running = false;
  var GLYPHS = 'DECRYPT2.0<>/\\|#%&$@=+*'.split('');

  function size() {
    if (!canvas) return;
    var parent = canvas.parentElement;
    canvas.width  = parent.clientWidth  * (window.devicePixelRatio > 1 ? 1.5 : 1);
    canvas.height = parent.clientHeight * (window.devicePixelRatio > 1 ? 1.5 : 1);
    cols = Math.floor(canvas.width / 18);
    drops = [];
    for (var i = 0; i < cols; i++) drops[i] = Math.random() * -40;
  }

  function draw() {
    if (!running) return;
    var color = cssVar('--accent-light') || '#9CF0B0';
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '13px "JetBrains Mono", monospace';
    for (var i = 0; i < cols; i++) {
      var ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      var x = i * 18, y = drops[i] * 18;
      ctx.fillStyle = Math.random() > 0.975 ? '#FFFFFF' : color;
      ctx.globalAlpha = 0.9;
      ctx.fillText(ch, x, y);
      ctx.globalAlpha = 1;
      if (y > canvas.height && Math.random() > 0.976) drops[i] = 0;
      drops[i]++;
    }
    raf = requestAnimationFrame(draw);
  }

  function start() {
    if (_reduceMotion) return;
    canvas = document.getElementById('auth-fx-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    size();
    running = true;
    cancelAnimationFrame(raf);
    draw();
    window.addEventListener('resize', size);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  return { start: start, stop: stop };
})();

/* ==========================================================
   UNLOCK SEQUENCE — cinematic access gate
   First login: full sequence. Returning login: brief.
   Reduced motion / FX off: near-instant.
   ========================================================== */
var UnlockSequence = (function () {
  var veil, statusEl, barEl, timers = [];

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    veil.classList.remove('granted');
    barEl.style.width = '0%';
  }

  function run(isFirst, onDone) {
    veil = document.getElementById('unlock-veil');
    statusEl = document.getElementById('unlock-status');
    barEl = document.getElementById('unlock-bar-fill');
    reset();
    veil.classList.add('visible');
    veil.setAttribute('aria-hidden', 'false');

    if (_reduceMotion) {
      statusEl.textContent = 'ACCESS GRANTED';
      later(function () { finish(onDone); }, 350);
      return;
    }

    if (isFirst) {
      statusEl.textContent = 'VERIFYING…';
      later(function () { barEl.style.width = '34%'; }, 60);
      later(function () { statusEl.textContent = 'SCANNING ACCESS CODE…'; barEl.style.width = '62%'; }, 650);
      later(function () { statusEl.textContent = 'DECRYPTING…'; barEl.style.width = '86%'; }, 1350);
      later(function () {
        veil.classList.add('granted');
        statusEl.textContent = 'ACCESS GRANTED';
        barEl.style.width = '100%';
      }, 1950);
      later(function () { finish(onDone); }, 2650);
    } else {
      statusEl.textContent = 'AUTHENTICATING…';
      later(function () { barEl.style.width = '55%'; }, 60);
      later(function () {
        veil.classList.add('granted');
        statusEl.textContent = 'ACCESS GRANTED';
        barEl.style.width = '100%';
      }, 620);
      later(function () { finish(onDone); }, 1250);
    }
  }

  function finish(onDone) {
    veil.classList.remove('visible');
    veil.setAttribute('aria-hidden', 'true');
    if (onDone) onDone();
  }

  return { run: run };
})();

/* ==========================================================
   AUTH
   ========================================================== */
var Auth = (function () {
  function init() {
    var saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        _participant = JSON.parse(saved);
        showPortal();
        return;
      } catch (e) {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
    AuthFX.start();
    var scr = document.getElementById('auth-scramble');
    if (scr) scramble(scr, scr.textContent);
    bindAuthForm();
    bindRecovery();
  }

  /* Recovery panel — no backend resend endpoint exists, so we
     offer concrete self-serve steps + a contact mailto only. */
  function bindRecovery() {
    var toggle = document.getElementById('recovery-toggle');
    var wrap = document.querySelector('.auth-recovery');
    if (!toggle || !wrap) return;
    toggle.addEventListener('click', function () {
      var open = wrap.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function bindAuthForm() {
    var btn   = document.getElementById('auth-btn');
    var label = document.getElementById('auth-btn-label');
    var err   = document.getElementById('auth-error');
    var emailInput = document.getElementById('auth-email');
    var codeInput = document.getElementById('auth-code');

    codeInput.addEventListener('input', function () {
      var pos = codeInput.selectionStart;
      codeInput.value = codeInput.value.toUpperCase();
      codeInput.setSelectionRange(pos, pos);
      err.textContent = '';
      setCodeState(codeInput, codeState(normalizeCode(codeInput.value)));
    });

    function attempt() {
      var email = emailInput.value.trim().toLowerCase();
      var code  = normalizeCode(codeInput.value);
      if (!email || !code) {
        err.textContent = 'Please enter both your email and access code.';
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        err.textContent = 'That email address doesn\'t look right — please check it.';
        emailInput.focus();
        return;
      }
      btn.disabled = true;
      label.textContent = 'Verifying…';
      err.textContent = '';
      setCodeState(codeInput, '');

      apiFetch({ action: 'portal_auth', email: email, code: code })
        .then(function (d) {
          if (d.ok) {
            _participant = d.participant;
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(_participant));
            AuthFX.stop();
            /* first-ever unlock on this device = full cinematic */
            var seen = false;
            try { seen = !!localStorage.getItem(SEEN_KEY); } catch (e) {}
            try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
            label.textContent = 'Unlock access';
            btn.disabled = false;
            UnlockSequence.run(!seen, showPortal);
          } else {
            label.textContent = 'Unlock access';
            btn.disabled = false;
            err.textContent = d.error || 'Email and access code do not match. Please check and try again.';
            setCodeState(codeInput, 'invalid');
            var field = document.getElementById('auth-form');
            field.classList.add('shake');
            setTimeout(function () { field.classList.remove('shake'); }, 420);
          }
        })
        .catch(function () {
          label.textContent = 'Unlock access';
          btn.disabled = false;
          err.textContent = 'CONNECTION INTERRUPTED — check your internet connection and try again.';
        });
    }

    btn.addEventListener('click', attempt);
    emailInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') codeInput.focus(); });
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') attempt(); });
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    _participant = null;
    if (_campaignTimer) clearInterval(_campaignTimer);
    SessionLive.stop();
    closeModal('pass-overlay');
    closeModal('dd-modal');
    document.getElementById('portal-shell').style.display = 'none';
    var veil = document.getElementById('auth-veil');
    veil.style.display = '';
    document.getElementById('auth-email').value = '';
    var codeInput = document.getElementById('auth-code');
    codeInput.value = '';
    setCodeState(codeInput, '');
    document.getElementById('auth-btn-label').textContent = 'Unlock access';
    document.getElementById('auth-btn').disabled = false;
    document.getElementById('auth-error').textContent = '';
    AuthFX.start();
    var scr = document.getElementById('auth-scramble');
    if (scr) scramble(scr, 'CREATIVITY, WITH INTENTION.');
    document.getElementById('auth-email').focus();
  }

  return { init: init, logout: logout };
})();

/* ==========================================================
   NAV — sliding indicator + desktop/mobile sync
   ========================================================== */
function positionNavIndicator() {
  var ind = document.getElementById('portal-nav-indicator');
  if (!ind) return;
  var active = document.querySelector('.portal-nav-inner .portal-nav-item.active');
  if (!active) { ind.style.width = '0px'; return; }
  ind.style.width = active.offsetWidth - 22 + 'px';
  ind.style.transform = 'translateX(' + (active.offsetLeft + 11) + 'px)';
}

function activateTab(tab) {
  document.querySelectorAll('.portal-nav-item, .bnav-item').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.portal-tab').forEach(function (t) {
    t.classList.toggle('active', t.id === 'tab-' + tab);
  });
  positionNavIndicator();
  observeReveals(document.getElementById('tab-' + tab));
  if (window.innerWidth <= 760) window.scrollTo({ top: 0, behavior: _reduceMotion ? 'auto' : 'smooth' });
}

function bindNav() {
  document.querySelectorAll('.portal-nav-item, .bnav-item').forEach(function (btn) {
    if (btn.dataset.bound === 'nav') return;
    btn.dataset.bound = 'nav';
    btn.addEventListener('click', function () { activateTab(this.dataset.tab); });
  });

  if (!window.__decryptNavBound) {
    window.__decryptNavBound = true;
    window.addEventListener('resize', positionNavIndicator);
    window.addEventListener('load', positionNavIndicator);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionNavIndicator);
  }
}

/* ==========================================================
   BANNER — canvas compositing + scanline overlay
   ========================================================== */
function renderBanner(code) {
  var canvas   = document.getElementById('portal-banner-canvas');
  var fallback = document.getElementById('portal-banner-fallback');
  var fallCode = document.getElementById('portal-banner-fallback-code');

  if (fallCode) fallCode.textContent = code;

  if (!BANNER_IMAGE_URL) {
    canvas.style.display = 'none';
    fallback.classList.add('active');
    return;
  }

  var img = new Image();
  img.crossOrigin = 'anonymous';

  img.onload = function () {
    var W = canvas.parentElement.offsetWidth || 640;
    var scale = W / img.naturalWidth;
    var H = img.naturalHeight * scale;

    canvas.width  = W;
    canvas.height = H;
    canvas.style.display = 'block';
    fallback.classList.remove('active');

    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);

    /* Vignette for legibility */
    var vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, W * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0.18)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    /* Access code overlay */
    var fontSize = Math.round(Math.max(14, W * 0.028));
    ctx.font = '700 ' + fontSize + 'px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 12;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = cssVar('--banner-code') || '#FFFFFF';
    ctx.fillText(code, W / 2, H / 2);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  };

  img.onerror = function () {
    canvas.style.display = 'none';
    fallback.classList.add('active');
  };

  img.src = BANNER_IMAGE_URL;
}

/* ==========================================================
   DIGITAL DECRYPT PASS — hero identity component
   Reuses the participant's existing QR identity (same
   quickchart URL builder as the QR tab — one identity).
   ========================================================== */
var DecryptPass = (function () {
  function qrUrl(p) {
    return 'https://quickchart.io/qr?text=' + encodeURIComponent(p.code) +
           '&size=240&margin=1&dark=07220C&light=FFFFFF';
  }

  function passHtml(p, big) {
    var checkedIn = p.status === 'CHECKED_IN';
    return '<div class="dxpass' + (big ? ' full' : '') + '" id="dxpass-card" role="button" tabindex="0" aria-label="Open Digital DECRYPT Pass">' +
      '<div class="dxpass-head">' +
        '<div class="dxpass-brand">' +
          '<span class="dxpass-brand-dot"></span>' +
          '<span class="dxpass-brand-name">DECRYPT</span>' +
          '<span class="dxpass-brand-ed">2.0</span>' +
        '</div>' +
        '<span class="dxpass-type">PARTICIPANT</span>' +
      '</div>' +
      '<div class="dxpass-body">' +
        '<div class="dxpass-idblock">' +
          '<div class="dxpass-name">' + esc(p.name) + '</div>' +
          '<div class="dxpass-id mono">' + esc(p.code) + '</div>' +
          '<span class="dxpass-verified">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
            (checkedIn ? 'VERIFIED · CHECKED IN' : 'VERIFIED PARTICIPANT') +
            '<span class="v-dot"></span>' +
          '</span>' +
        '</div>' +
        '<div class="dxpass-qr"><img src="' + qrUrl(p) + '" alt="Pass QR for ' + esc(p.code) + '" width="' + (big ? 150 : 92) + '" height="' + (big ? 150 : 92) + '"></div>' +
      '</div>' +
      '<div class="dxpass-foot">' +
        '<span class="dxpass-motto">KNOWLEDGE SHOULD NOT STAY LOCKED.</span>' +
        (big ? '' : '<span class="dxpass-tap">TAP TO EXPAND</span>') +
      '</div>' +
      '<span class="dxpass-notch left" aria-hidden="true"></span>' +
      '<span class="dxpass-notch right" aria-hidden="true"></span>' +
    '</div>';
  }

  function render(p) {
    var slot = document.getElementById('pass-slot');
    if (!slot) return;
    slot.innerHTML = passHtml(p, false);
    var card = document.getElementById('dxpass-card');
    bindTilt(card, 5);
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }

  function open() {
    if (!_participant) return;
    var full = document.getElementById('pass-full');
    full.innerHTML = passHtml(_participant, true);
    openModal('pass-overlay');
    var saveBtn = document.getElementById('pass-save');
    saveBtn.style.display = DECRYPT_FEATURES.passDownload ? '' : 'none';
  }

  function close() { closeModal('pass-overlay'); }

  /* Best-effort PNG export — canvas-composited, no dependencies.
     Needs the QR host to allow CORS; degrades with a toast. */
  function save() {
    var p = _participant;
    if (!p) return;
    var W = 1000, H = 620;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');

    var bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#061B0A'); bg.addColorStop(0.55, '#0B3A1A'); bg.addColorStop(1, '#0E5A28');
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, W, H, 40); ctx.fill();

    /* faint grid */
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (var gx = 0; gx <= W; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (var gy = 0; gy <= H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    ctx.fillStyle = '#9CF0B0';
    ctx.beginPath(); ctx.arc(70, 88, 8, 0, Math.PI * 2); ctx.fill();
    ctx.font = '800 34px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('DECRYPT', 92, 100);
    ctx.font = '500 20px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('2.0', 262, 99);
    ctx.textAlign = 'right';
    ctx.fillText('PARTICIPANT', W - 70, 96);
    ctx.textAlign = 'left';

    ctx.font = '800 52px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    wrapText(ctx, p.name, 70, 300, 560, 58);
    ctx.font = '500 30px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(p.code, 70, 400);

    ctx.font = '700 22px "JetBrains Mono", monospace';
    ctx.fillStyle = '#9CF0B0';
    ctx.fillText(p.status === 'CHECKED_IN' ? 'VERIFIED · CHECKED IN' : 'VERIFIED PARTICIPANT', 70, 460);

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(70, 520); ctx.lineTo(W - 70, 520); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '500 18px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('KNOWLEDGE SHOULD NOT STAY LOCKED.', 70, 566);

    /* QR box */
    ctx.fillStyle = '#FFFFFF';
    roundRect(ctx, W - 320, 240, 250, 250, 26); ctx.fill();

    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, W - 305, 255, 220, 220);
      download();
    };
    img.onerror = function () {
      /* still export the pass, just without the QR tiles */
      ctx.fillStyle = '#07220C';
      ctx.font = '700 22px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.code, W - 195, 372);
      ctx.textAlign = 'left';
      download();
    };
    img.src = qrUrl(p).replace('size=240', 'size=440');

    function download() {
      try {
        var a = document.createElement('a');
        a.href = cv.toDataURL('image/png');
        a.download = 'DECRYPT-PASS-' + p.code + '.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        toast('Pass saved — check your downloads.');
      } catch (e) {
        toast('Couldn\'t export the pass on this browser.');
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapText(ctx, text, x, y, maxW, lh) {
    var words = String(text).split(' ');
    var line = '', yy = y;
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, yy); line = words[i]; yy += lh;
      } else line = test;
    }
    ctx.fillText(line, x, yy);
  }

  function init() {
    document.getElementById('pass-close').addEventListener('click', close);
    document.getElementById('pass-save').addEventListener('click', save);
  }

  return { render: render, init: init };
})();

/* ==========================================================
   SESSION LIVE — Live Now + next-session countdown
   Data source: DECRYPT_SESSIONS config (see top of file).
   No fabricated live state; graceful empty states.
   ========================================================== */
var SessionLive = (function () {
  var _fx = true;

  function setFx(on) { _fx = on; }

  function sessions() {
    return (DECRYPT_SESSIONS || []).filter(function (s) {
      return s && s.startISO && s.endISO &&
        !isNaN(new Date(s.startISO).getTime()) &&
        !isNaN(new Date(s.endISO).getTime());
    });
  }

  function compute() {
    var now = Date.now();
    var list = sessions();
    var live = null, next = null;
    list.forEach(function (s) {
      var st = new Date(s.startISO).getTime();
      var en = new Date(s.endISO).getTime();
      if (now >= st && now <= en) live = s;
      if (st > now && (!next || st < new Date(next.startISO).getTime())) next = s;
    });
    return { live: live, next: next };
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    } catch (e) { return ''; }
  }

  function render() {
    var slot = document.getElementById('live-slot');
    if (!slot) return;
    if (!DECRYPT_FEATURES.liveSessions || !sessions().length) {
      slot.innerHTML = '';
      stop();
      return;
    }
    draw();
    start();
  }

  function draw() {
    var slot = document.getElementById('live-slot');
    var st = compute();
    var html = '';

    if (st.live) {
      var s = st.live;
      html += '<div class="live-card is-live reveal" id="live-card">' +
        '<div class="live-eyebrow"><span class="live-dot"></span>LIVE NOW</div>' +
        '<div class="live-title">' + esc(s.title || 'DECRYPT Session') + '</div>' +
        (s.speaker ? '<div class="live-meta">with ' + esc(s.speaker) + '</div>' : '') +
        (s.description ? '<div class="live-desc">' + esc(s.description) + '</div>' : '') +
        '<div class="live-cta-row">' +
          (s.link
            ? '<a class="live-cta" href="' + esc(s.link) + '" target="_blank" rel="noopener">JOIN SESSION →</a>'
            : '<button class="live-cta" data-goto="event">SESSION INFO →</button>') +
        '</div></div>';
    } else if (st.next) {
      var n = st.next;
      html += '<div class="live-card reveal" id="live-card">' +
        '<div class="live-eyebrow">NEXT SESSION</div>' +
        '<div class="live-title">' + esc(n.title || 'DECRYPT Session') + '</div>' +
        '<div class="live-meta">' + esc(n.speaker ? 'with ' + n.speaker + ' · ' : '') + esc(fmtDate(n.startISO)) + '</div>' +
        '<div class="count-grid" aria-label="Countdown to next session">' +
          countCell('dd', 'Days') + '<span class="count-sep">:</span>' +
          countCell('hh', 'Hrs') + '<span class="count-sep">:</span>' +
          countCell('mm', 'Min') + '<span class="count-sep">:</span>' +
          countCell('ss', 'Sec') +
        '</div>' +
        '<div class="live-cta-row">' +
          '<button class="live-cta ghost" data-goto="event">VIEW SESSION →</button>' +
        '</div></div>';
    } else {
      html += '<div class="live-card reveal" id="live-card">' +
        '<div class="live-eyebrow">NOT LIVE RIGHT NOW</div>' +
        '<div class="live-title">DECRYPT 2.0 is on the way</div>' +
        '<div class="live-meta">No upcoming session available right now — check the Event tab for the latest updates.</div>' +
        '<div class="live-cta-row"><button class="live-cta ghost" data-goto="event">EVENT INFO →</button></div>' +
        '</div>';
    }

    slot.innerHTML = html;
    observeReveals(slot);
    slot.querySelectorAll('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { activateTab(this.dataset.goto); });
    });
    tick();
  }

  function countCell(id, label) {
    return '<div class="count-cell"><div class="count-num" id="count-' + id + '">00</div>' +
      '<div class="count-lbl">' + label + '</div></div>';
  }

  function tick() {
    var st = compute();
    if (st.live) {
      /* a session just started — flip the card */
      var card = document.getElementById('live-card');
      if (card && !card.classList.contains('is-live')) draw();
      return;
    }
    if (!st.next) return;
    var diff = new Date(st.next.startISO).getTime() - Date.now();
    if (diff <= 0) { draw(); return; }
    var d = Math.floor(diff / 86400000);
    var h = Math.floor(diff % 86400000 / 3600000);
    var m = Math.floor(diff % 3600000 / 60000);
    var s = Math.floor(diff % 60000 / 1000);
    setNum('count-dd', d); setNum('count-hh', h);
    setNum('count-mm', m); setNum('count-ss', s);
  }

  function setNum(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = (v < 10 ? '0' : '') + v;
  }

  function start() {
    stop();
    _sessionTimer = setInterval(function () {
      if (!document.hidden) tick();
    }, 1000);
  }

  function stop() {
    if (_sessionTimer) { clearInterval(_sessionTimer); _sessionTimer = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else if (document.getElementById('live-card')) start();
  });

  return { render: render, stop: stop, setFx: setFx };
})();

/* ==========================================================
   DAILY DECRYPT — playable cipher game (local persistence)
   Mechanic: the daily word has been Caesar-shifted. Dial the
   shift, watch the decode, crack the code. ~45 seconds.
   State is stored locally and clearly labelled as such.
   ========================================================== */
var DailyDecrypt = (function () {
  var BANK = ['UNLOCK', 'DECRYPT', 'DESIGN', 'CREATE', 'CIPHER', 'CANVAS',
              'INTENT', 'SIGNAL', 'VECTOR', 'ORIGIN', 'MOSAIC', 'PATTERN',
              'PIXELS', 'BRIDGE', 'SYNTAX'];
  var SHIFT_MIN = 1, SHIFT_MAX = 9, TIME = 45;
  var st = null;           /* active game state */
  var _timer = null;

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function dayNumber() {
    var d = new Date();
    return d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate();
  }
  function wordForToday() { return BANK[dayNumber() % BANK.length]; }
  function winKey() { return 'dcmd_daily_win_' + todayKey(); }
  function wonToday() { try { return !!localStorage.getItem(winKey()); } catch (e) { return false; } }

  function caesar(word, shift) {
    return word.split('').map(function (ch) {
      var c = ch.charCodeAt(0) - 65;
      return String.fromCharCode((c + shift + 26) % 26 + 65);
    }).join('');
  }

  /* ---------- home card ---------- */
  function render() {
    var slot = document.getElementById('daily-slot');
    if (!slot) return;
    if (!DECRYPT_FEATURES.dailyChallenge) { slot.innerHTML = ''; return; }
    var won = wonToday();
    slot.innerHTML = '<button class="dd-card reveal' + (won ? ' won' : '') + '" id="dd-card">' +
      '<span class="dd-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/></svg></span>' +
      '<span class="dd-info">' +
        '<span class="dd-label">DAILY DECRYPT</span>' +
        '<span class="dd-title" style="display:block">Crack the code</span>' +
        '<span class="dd-sub" style="display:block">' + (won ? 'Code cracked today — come back tomorrow.' : 'Today\'s code is waiting. ~45 seconds.') + '</span>' +
      '</span>' +
      '<span class="dd-cta">' + (won ? 'CRACKED ✓' : 'PLAY →') + '</span>' +
      '</button>';
    observeReveals(slot);
    document.getElementById('dd-card').addEventListener('click', open);
  }

  /* ---------- game modal ---------- */
  function open() {
    st = {
      word: wordForToday(),
      shift: SHIFT_MIN + (dayNumber() % (SHIFT_MAX - SHIFT_MIN + 1)), /* 1..9 */
      guess: 3, timeLeft: TIME, over: false, tries: 0
    };
    buildPlay();
    openModal('dd-modal');
    startTimer();
  }

  function buildPlay() {
    var body = document.getElementById('dd-body');
    body.innerHTML =
      '<div class="dd-head">' +
        '<p class="dd-challenge-no">CHALLENGE ' + String(dayNumber() % 1000).padStart(3, '0') + ' · ' + todayKey() + '</p>' +
        '<h3 class="dd-challenge-title">Crack the code</h3>' +
        '<p class="dd-hint" style="margin-top:8px">The word below was encrypted by shifting every letter forward in the alphabet. Dial the shift to decode it.</p>' +
      '</div>' +
      '<div class="dd-timerbar"><span class="dd-timerfill" id="dd-timerfill"></span></div>' +
      '<p class="dd-timerlbl" id="dd-timerlbl">' + TIME + 's</p>' +
      '<div class="dd-encoded" id="dd-encoded">' + chips(caesar(st.word, st.shift)) + '</div>' +
      '<div class="dd-shift-row">' +
        '<button class="dd-shift-btn" id="dd-minus" aria-label="Decrease shift">‹</button>' +
        '<div><div class="dd-shift-val" id="dd-shiftval">' + st.guess + '</div>' +
        '<div class="dd-shift-lbl">Shift</div></div>' +
        '<button class="dd-shift-btn" id="dd-plus" aria-label="Increase shift">›</button>' +
      '</div>' +
      '<div class="dd-preview" id="dd-preview" aria-live="polite"></div>' +
      '<button class="dd-crack-btn" id="dd-crack">CRACK THE CODE</button>';

    document.getElementById('dd-minus').addEventListener('click', function () { setGuess(st.guess - 1); });
    document.getElementById('dd-plus').addEventListener('click', function () { setGuess(st.guess + 1); });
    document.getElementById('dd-crack').addEventListener('click', crack);
    updatePreview();

    /* swipe-friendly: arrow keys too */
    document.getElementById('dd-minus').addEventListener('keydown', arrowKeys);
    document.getElementById('dd-plus').addEventListener('keydown', arrowKeys);
  }

  function arrowKeys(e) {
    if (e.key === 'ArrowLeft') setGuess(st.guess - 1);
    if (e.key === 'ArrowRight') setGuess(st.guess + 1);
  }

  function chips(word) {
    return word.split('').map(function (ch) {
      return '<span class="dd-chip">' + ch + '</span>';
    }).join('');
  }

  function setGuess(v) {
    if (!st || st.over) return;
    if (v < SHIFT_MIN) v = SHIFT_MAX;
    if (v > SHIFT_MAX) v = SHIFT_MIN;
    st.guess = v;
    document.getElementById('dd-shiftval').textContent = v;
    updatePreview();
  }

  function updatePreview() {
    var decoded = caesar(caesar(st.word, st.shift), -st.guess);
    var prev = document.getElementById('dd-preview');
    prev.innerHTML = decoded.split('').map(function (ch) {
      return '<span class="dd-prev-chip">' + ch + '</span>';
    }).join('');
  }

  function crack() {
    if (!st || st.over) return;
    st.tries++;
    if (st.guess === st.shift) success();
    else {
      var card = document.querySelector('.dd-modal-card');
      card.classList.remove('shake');
      void card.offsetWidth; /* restart animation */
      card.classList.add('shake');
      toast(st.guess < st.shift ? 'ACCESS DENIED — try a bigger shift' : 'ACCESS DENIED — try a smaller shift');
    }
  }

  function success() {
    st.over = true;
    stopTimer();
    var bonus = Math.max(0, st.timeLeft) * 2;
    var xp = 100 + bonus;
    try { localStorage.setItem(winKey(), '1'); } catch (e) {}
    Progress.addXP(xp, 'Code cracked');
    buildResult(true, xp);
    Progress.refresh();
    render();
  }

  function fail() {
    st.over = true;
    stopTimer();
    buildResult(false, 0);
  }

  function buildResult(won, xp) {
    var body = document.getElementById('dd-body');
    if (won) {
      body.innerHTML =
        '<div class="dd-result">' +
          '<div class="dd-unlock-anim"><div class="unlock-ring granted" style="border-color:rgba(18,128,58,0.25);color:var(--accent-mid)">' +
            '<svg class="unlock-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path class="unlock-shackle" d="M8 10V7a4 4 0 0 1 8 0v3" style="transform:rotate(-38deg);transform-origin:8px 10px"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/></svg>' +
          '</div></div>' +
          '<h3 class="dd-result-title ok">CODE CRACKED ✓</h3>' +
          '<p class="dd-result-sub">“' + esc(st.word) + '” — decrypted in ' + (TIME - st.timeLeft) + 's · ' + st.tries + ' attempt' + (st.tries === 1 ? '' : 's') + '.</p>' +
          '<p class="dd-result-xp">+' + xp + ' XP</p>' +
          '<p class="dd-result-sub" style="margin-top:10px;font-size:0.72rem;color:var(--text-muted)">Progress stored on this device.</p>' +
          '<button class="dd-crack-btn" id="dd-done" style="margin-top:18px">DONE</button>' +
        '</div>';
      document.getElementById('dd-done').addEventListener('click', function () { closeModal('dd-modal'); });
    } else {
      body.innerHTML =
        '<div class="dd-result">' +
          '<h3 class="dd-result-title no">CODE NOT CRACKED</h3>' +
          '<p class="dd-result-sub">The window closed before the code was decrypted. No stress — the next challenge is already waiting.</p>' +
          '<button class="dd-crack-btn" id="dd-retry" style="margin-top:18px">TRY AGAIN</button>' +
          '<button class="pass-close-btn" id="dd-quit" style="width:100%;margin-top:10px">CLOSE</button>' +
        '</div>';
      document.getElementById('dd-retry').addEventListener('click', open);
      document.getElementById('dd-quit').addEventListener('click', function () { closeModal('dd-modal'); });
    }
  }

  function startTimer() {
    stopTimer();
    var fill = document.getElementById('dd-timerfill');
    var lbl = document.getElementById('dd-timerlbl');
    _timer = setInterval(function () {
      if (document.hidden || !st || st.over) return;
      st.timeLeft--;
      if (fill) fill.style.width = Math.max(0, (st.timeLeft / TIME) * 100) + '%';
      if (lbl) lbl.textContent = st.timeLeft + 's';
      if (st.timeLeft <= 0) fail();
    }, 1000);
  }

  function stopTimer() { if (_timer) { clearInterval(_timer); _timer = null; } }

  function init() {
    document.getElementById('dd-close').addEventListener('click', function () {
      stopTimer();
      if (st) st.over = true;
      closeModal('dd-modal');
    });
  }

  return { render: render, init: init };
})();

/* ==========================================================
   PROGRESS — XP, achievements, journey
   Sources of truth: real participant fields (status,
   checkinTime, certStatus, registeredAt) + honestly-labeled
   local device state (daily wins, XP). No fabricated data.
   ========================================================== */
var Progress = (function () {

  function getXP() {
    try { return parseInt(localStorage.getItem(XP_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }

  function addXP(n, reason) {
    var total = getXP() + n;
    try { localStorage.setItem(XP_KEY, String(total)); } catch (e) {}
    toast('+' + n + ' XP · ' + (reason || 'DECRYPT progress'));
    renderXP();
  }

  function dailyWins() {
    var count = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('dcmd_daily_win_') === 0) count++;
      }
    } catch (e) {}
    return count;
  }

  function definitions(p) {
    var checkedIn = p && p.status === 'CHECKED_IN';
    var early = false;
    if (p && p.registeredAt) {
      var r = new Date(p.registeredAt).getTime();
      var cut = new Date(EARLY_ACCESS_CUTOFF).getTime();
      early = !isNaN(r) && !isNaN(cut) && r < cut;
    }
    return [
      { id: 'first-unlock', name: 'FIRST UNLOCK', desc: 'Entered the DECRYPT portal',
        icon: 'key', unlocked: true },
      { id: 'code-cracker', name: 'CODE CRACKER', desc: 'Cracked a Daily Decrypt',
        icon: 'cipher', unlocked: dailyWins() > 0 },
      { id: 'knowledge-seeker', name: 'KNOWLEDGE SEEKER', desc: 'Checked in at DECRYPT 2.0',
        icon: 'book', unlocked: checkedIn },
      { id: 'early-access', name: 'EARLY ACCESS', desc: 'Registered before Oct 2026',
        icon: 'bolt', unlocked: early },
      { id: 'decrypted', name: 'DECRYPTED', desc: 'Certificate issued',
        icon: 'cert', unlocked: !!(p && p.certStatus === 'Sent' && p.certUrl) }
    ];
  }

  function journey(p) {
    var xp = getXP();
    var checkedIn = p && p.status === 'CHECKED_IN';
    return [
      { label: 'ENTERED',  done: true },
      { label: 'ATTENDED', done: checkedIn },
      { label: 'LEARNED',  done: xp >= 200 || dailyWins() > 0 },
      { label: 'CREATED',  done: xp >= 400 },
      { label: 'DECRYPTED', done: !!(p && p.certStatus === 'Sent') }
    ];
  }

  function icons(name) {
    var paths = {
      key: '<circle cx="8" cy="15" r="4"/><path d="M11 12 20 3M16 7l3 3M13 10l2 2"/>',
      cipher: '<rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
      bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>',
      cert: '<circle cx="12" cy="9" r="6"/><path d="M9 14.5 7.5 22 12 19l4.5 3-1.5-7.5"/>'
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.key) + '</svg>';
  }

  function renderXP() {
    var el = document.getElementById('journey-xp');
    if (el) el.textContent = getXP().toLocaleString() + ' XP';
  }

  function render(p) {
    if (!DECRYPT_FEATURES.achievements) return;
    var jEl = document.getElementById('journey-slot');
    var aEl = document.getElementById('ach-slot');
    if (!jEl || !aEl) return;

    var steps = journey(p);
    var done = steps.filter(function (s) { return s.done; }).length;
    jEl.innerHTML = '<div class="journey-card reveal">' +
      '<div class="journey-head">' +
        '<span class="journey-title">Your DECRYPT journey</span>' +
        '<span class="xp-pill" id="journey-xp">' + getXP().toLocaleString() + ' XP</span>' +
      '</div>' +
      '<div class="journey-track">' +
        steps.map(function (s) {
          return '<div class="journey-step' + (s.done ? ' done' : '') + '">' +
            '<span class="journey-dot">' + (s.done ? '✓' : '') + '</span>' +
            '<span class="journey-step-label">' + s.label + '</span>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<p class="journey-meta">' + done + ' / ' + steps.length + ' MILESTONES UNLOCKED</p>' +
      '</div>';

    var defs = definitions(p);
    var un = defs.filter(function (a) { return a.unlocked; }).length;
    aEl.innerHTML = '<div class="ach-section reveal">' +
      '<div class="ach-head"><span class="ach-title">Achievements</span>' +
      '<span class="ach-count">' + un + ' / ' + defs.length + '</span></div>' +
      '<div class="ach-grid">' +
        defs.map(function (a) {
          return '<div class="ach' + (a.unlocked ? ' unlocked' : '') + '">' +
            '<span class="ach-icon">' + icons(a.icon) + '</span>' +
            '<span style="min-width:0"><span class="ach-name" style="display:block">' + a.name + '</span>' +
            '<span class="ach-desc" style="display:block">' + a.desc + '</span></span>' +
          '</div>';
        }).join('') +
      '</div></div>';

    observeReveals(document.getElementById('tab-home'));
  }

  function refresh() { if (_participant) render(_participant); }

  return { render: render, refresh: refresh, addXP: addXP, getXP: getXP };
})();

/* ==========================================================
   PORTAL
   ========================================================== */
function bindPortalShell() {
  if (document.body && document.body.dataset.portalShellBound === '1') return;

  var logoutBtn = document.getElementById('portal-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', Auth.logout);

  window.addEventListener('themechange', function () {
    if (_participant) renderBanner(_participant.code);
  });

  document.body.dataset.portalShellBound = '1';
}

function refreshPortal() {
  if (!_participant) return;

  var p = _participant;
  var firstName = (p.name || '').split(' ')[0];
  var portalGreeting = document.getElementById('portal-greeting');
  if (portalGreeting) portalGreeting.textContent = 'Hi, ' + firstName;

  var checkedIn = p.status === 'CHECKED_IN';
  var statusPill = document.getElementById('portal-status-pill');
  if (statusPill) {
    statusPill.innerHTML = pill(checkedIn ? 'Checked in' : 'Registered', checkedIn ? 'green' : 'amber');
  }

  renderBanner(p.code);
  renderHome(p);
  renderDetails(p);
  renderQR(p);
  renderCertificate(p);

  /* v3 experience layers */
  DecryptPass.render(p);
  SessionLive.render();
  DailyDecrypt.render();
  Progress.render(p);

  bindNav();
  fetchEventInfo();
  startCampaignPolling();
  observeReveals(document);
}

function showPortal() {
  document.getElementById('auth-veil').style.display = 'none';
  document.getElementById('portal-shell').style.display = '';

  bindPortalShell();
  refreshPortal();
}

/* ==========================================================
   HOME TAB
   ========================================================== */
function renderHome(p) {
  var checkedIn = p.status === 'CHECKED_IN';

  scramble(document.getElementById('home-title'), 'WELCOME, ' + firstNameOf(p).toUpperCase() + '.');
  document.getElementById('home-sub').textContent =
    'Participant · DECRYPT 2.0' + (checkedIn ? ' · Checked in' : '');

  document.getElementById('home-cards').innerHTML = [
    { label: 'Track',       value: p.track || '—' },
    { label: 'Check-in',    value: checkedIn ? '✓ Done' : 'Pending' },
    { label: 'Certificate', value: p.certStatus || 'Pending' }
  ].map(function (c) {
    return '<div class="home-card"><div class="home-card-label">' + esc(c.label) + '</div>' +
      '<div class="home-card-value">' + esc(c.value) + '</div></div>';
  }).join('');

  document.getElementById('home-quick').innerHTML = [
    { tab: 'details', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
      label: 'My registration details', meta: 'View everything we have on file' },
    { tab: 'event', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
      label: 'Event information', meta: 'Schedule, joining link and announcements' },
    { tab: 'qr', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h.01M18 14h.01M14 18h.01M18 18h.01"/></svg>',
      label: 'My QR code', meta: 'For check-in at the event' },
    { tab: 'certificate', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="6"/><path d="M9 14.5L7.5 22 12 19l4.5 3-1.5-7.5"/></svg>',
      label: 'Certificate', meta: p.certStatus === 'Sent' ? 'Ready to download' : 'Issued after the event' }
  ].map(function (q) {
    return '<button class="home-quick-item" data-tab="' + q.tab + '">' +
      q.icon +
      '<div style="flex:1;min-width:0"><div class="home-quick-label">' + esc(q.label) + '</div>' +
      '<div class="home-quick-meta">' + esc(q.meta) + '</div></div>' +
      '<span class="home-quick-arrow">›</span></button>';
  }).join('');

  document.querySelectorAll('.home-quick-item').forEach(function (btn) {
    btn.addEventListener('click', function () { activateTab(this.dataset.tab); });
  });
}

function firstNameOf(p) { return (p.name || '').split(' ')[0] || 'there'; }

/* ==========================================================
   MY DETAILS TAB
   ========================================================== */
function renderDetails(p) {
  var checkedIn = p.status === 'CHECKED_IN';
  var fields = [
    { key: 'Full name',       val: p.name },
    { key: 'Email',           val: p.email },
    { key: 'Phone',           val: p.phone || '—' },
    { key: 'Location',        val: p.location || '—' },
    { key: 'I am mainly a',   val: p.identity || '—' },
    { key: 'Track',           val: p.track || '—' },
    { key: 'Volunteering',    val: p.volunteer || 'No' },
    { key: 'Heard via',       val: p.source || '—' },
    { key: 'Registered',      val: p.registeredAt ? new Date(p.registeredAt).toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' }) : '—' },
    { key: 'Access code',     val: p.code, mono: true },
    { key: 'Check-in status', val: checkedIn ? 'Checked in' : 'Not yet arrived', statusType: checkedIn ? 'green' : 'amber' },
    { key: 'Check-in time',   val: p.checkinTime ? new Date(p.checkinTime).toLocaleString() : '—' },
    { key: 'Certificate',     val: p.certStatus || 'Pending', statusType: p.certStatus === 'Sent' ? 'green' : 'neutral' }
  ];

  document.getElementById('details-grid').innerHTML = fields.map(function (f) {
    var valHtml;
    if (f.statusType) valHtml = pill(f.val, f.statusType);
    else if (f.mono)  valHtml = '<span class="mono" style="font-size:0.84rem;letter-spacing:0.06em;color:var(--accent-mid);font-weight:500">' + esc(f.val) + '</span>';
    else valHtml = esc(f.val);
    return '<div class="detail-row"><span class="detail-key">' + esc(f.key) + '</span><span class="detail-val">' + valHtml + '</span></div>';
  }).join('');
}

/* ==========================================================
   EVENT INFO TAB
   ========================================================== */
function fetchEventInfo() {
  var body = document.getElementById('event-info-body');
  body.innerHTML = '<div class="skel" style="height:130px;"></div>';

  apiFetch({ action: 'get_event_info' })
    .then(function (d) {
      if (!d || d.ok === false) {
        body.innerHTML = '<div class="event-empty">Event details will appear here soon.</div>';
        return;
      }
      renderEventInfo(d);
    })
    .catch(function () {
      body.innerHTML = '<div class="event-empty">Couldn\'t load event information — please try again later.</div>';
    });
}

function renderEventInfo(d) {
  var body = document.getElementById('event-info-body');
  var html = '';

  if (d.joiningLink) {
    html += '<div class="event-join-block">' +
      '<div><div class="event-join-label">Join DECRYPT WhatsApp Community</div>' +
      '<div class="event-join-text">Click to join for event info and updates</div></div>' +
      '<a class="event-join-btn" href="' + esc(d.joiningLink) + '" target="_blank" rel="noopener">Join now →</a>' +
      '</div>';
  }

  if (d.announcement) {
    html += '<div class="event-announcement">' +
      '<span class="event-announcement-dot"></span>' +
      '<div class="event-announcement-text">' + esc(d.announcement) + '</div>' +
      '</div>';
  }

  if (d.doorsOpen) {
    html += '<div class="event-block"><div class="event-block-title">' +
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>Doors open' +
      '</div><div class="event-block-body">' + esc(d.doorsOpen) + '</div></div>';
  }

  if (d.schedule) {
    html += '<div class="event-block"><div class="event-block-title">' +
      '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>Schedule' +
      '</div><div class="event-block-body">' + esc(d.schedule) + '</div></div>';
  }

  if (!html) html = '<div class="event-empty">Event details will appear here closer to October 2026.</div>';

  if (d.lastUpdated) {
    html += '<p class="label" style="margin-top:16px;">Last updated ' + esc(new Date(d.lastUpdated).toLocaleDateString()) + '</p>';
  }

  body.innerHTML = html;
}

/* ==========================================================
   QR TAB
   ========================================================== */
function renderQR(p) {
  var qrUrl = 'https://quickchart.io/qr?text=' + encodeURIComponent(p.code) +
              '&size=240&margin=1&dark=07220C&light=FFFFFF';
  document.getElementById('qr-img').src = qrUrl;
  document.getElementById('qr-img').alt = 'QR code for ' + p.code;

  var labelBtn = document.getElementById('qr-code-label');
  labelBtn.textContent = p.code;
  labelBtn.addEventListener('click', function () {
    var done = function () { toast('Access code copied to clipboard'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(p.code).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = p.code; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done();
    }
  });

  bindTilt(document.getElementById('qr-box'), 8);

  document.getElementById('qr-download-btn').addEventListener('click', function () {
    var a = document.createElement('a');
    a.href = qrUrl;
    a.download = 'DECRYPT-QR-' + p.code + '.png';
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('QR code downloading…');
  });
}

/* ==========================================================
   CERTIFICATE TAB
   ========================================================== */
function renderCertificate(p) {
  var body = document.getElementById('cert-body');
  var status = p.certStatus || '';

  if (status === 'Sent' && p.certUrl) {
    body.innerHTML = '<div class="cert-ready">' +
      '<div class="cert-preview-box">' +
      '<p class="label" style="margin-bottom:10px;">DECRYPT 2.0 Certificate</p>' +
      '<p style="font-family:var(--font-display);font-size:1.1rem;font-weight:700;">' + esc(p.name) + '</p>' +
      '<p style="font-size:0.82rem;color:var(--text-secondary);margin-top:6px;">Awarded for participation in DECRYPT 2.0</p>' +
      '</div>' +
      '<a class="cert-download-btn btn-ripple" href="' + esc(p.certUrl) + '" target="_blank" rel="noopener" download>Download certificate →</a>' +
      '<p class="qr-hint">Your certificate is a PDF. Save it or share it as you like.</p>' +
      '</div>';
  } else {
    var subMsg = !p.checkinTime
      ? 'Certificates are issued to participants who attended DECRYPT 2.0. Check back after the event.'
      : "You're eligible. Your certificate is being prepared and will appear here once issued.";
    body.innerHTML = '<div class="cert-placeholder">' +
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="6"/><path d="M9 14.5L7.5 22 12 19l4.5 3-1.5-7.5"/></svg>' +
      '<div class="cert-placeholder-title">Certificate pending</div>' +
      '<div class="cert-placeholder-sub">' + esc(subMsg) + '</div>' +
      '</div>';
  }
}

/* ==========================================================
   CAMPAIGN POLLING
   ========================================================== */
function startCampaignPolling() {
  pollCampaigns();
  _campaignTimer = setInterval(pollCampaigns, CAMPAIGN_POLL_INTERVAL);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearInterval(_campaignTimer);
    } else {
      pollCampaigns();
      _campaignTimer = setInterval(pollCampaigns, CAMPAIGN_POLL_INTERVAL);
    }
  });

  document.getElementById('campaign-alert-close').addEventListener('click', hideCampaignAlert);
}

function pollCampaigns() {
  apiFetch({ action: 'get_campaigns' })
    .then(function (d) {
      var campaigns = d.campaigns || [];
      if (!campaigns.length) return;
      var latest = campaigns[0];
      var lastSeen = '';
      try { lastSeen = localStorage.getItem(CAMPAIGN_KEY) || ''; } catch (e) {}
      if (latest.id && latest.id !== lastSeen) {
        showCampaignAlert('New message from DECRYPT — check your inbox.');
        try { localStorage.setItem(CAMPAIGN_KEY, latest.id); } catch (e) {}
      }
    })
    .catch(function () {}); /* silent */
}

function showCampaignAlert(msg) {
  var alert = document.getElementById('campaign-alert');
  document.getElementById('campaign-alert-msg').textContent = msg;
  alert.classList.add('visible');
  clearTimeout(showCampaignAlert._t);
  showCampaignAlert._t = setTimeout(hideCampaignAlert, 8000);
}

function hideCampaignAlert() {
  document.getElementById('campaign-alert').classList.remove('visible');
}

/* ==========================================================
   BOOT
   ========================================================== */
MotionFX.init();
Theme.init();
DecryptPass.init();
DailyDecrypt.init();
Auth.init();
