/**
 * sitebot embed loader.
 *
 * Usage on any website:
 *   <script src="https://sitebot-nu.vercel.app/loader.js"
 *           data-bot="pk_..." async></script>
 *
 * Optional attributes (override the bot's theme for this embed):
 *   data-color="#0ea5e9"      launcher color
 *   data-icon="🛎"            launcher icon (emoji or image URL)
 *   data-position="left"      launcher side
 *   data-width="420"          window width px
 *   data-height="640"         window height px
 *   data-label="Онлайн-чат"   aria label
 *
 * Theme (position, offsets, sizes, opacity, shadow, animation, palette,
 * dark mode, proactive teaser) comes from the bot via /api/bot.
 * The launcher is draggable; the chosen spot is remembered per visitor.
 * The chat window is a rounded wrapper with overflow:hidden (no white
 * corner artifacts), with animated open/close. Below 480px it opens
 * fullscreen with safe-area insets.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var botKey = script.getAttribute('data-bot');
  if (!botKey) {
    console.error('[sitebot] loader.js: атрибут data-bot обязателен');
    return;
  }

  var apiOrigin = new URL(script.src).origin;
  var attrs = {
    color: script.getAttribute('data-color'),
    icon: script.getAttribute('data-icon'),
    position: script.getAttribute('data-position'),
    width: parseFloat(script.getAttribute('data-width')) || null,
    height: parseFloat(script.getAttribute('data-height')) || null,
    label: script.getAttribute('data-label') || 'Открыть чат',
  };

  var LOADER_VERSION = 'v14';
  try {
    window.__sitebotLoader = LOADER_VERSION;
  } catch (e) {
    // ignore
  }
  console.log('[sitebot] loader ' + LOADER_VERSION + ' · bot ' + botKey);
  var DEFAULT_COLOR = '#4f46e5';
  var DEFAULT_ICON = '\uD83D\uDCAC';
  var Z = '2147483000';
  var TEASER_KEY = 'sitebot_teaser_' + botKey;

  var theme = {};
  var sessionPos = null;
  var state = {
    opened: false,
    teaserDismissed: false,
    dragging: false,
    suppressClick: false,
    entrancePlayed: false,
    windowPos: null,
  };

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', attrs.label);

  var frameWrap = null;
  var frameClip = null;
  var frame = null;
  var teaser = null;
  var labelEl = null;
  var badgeEl = null;
  var unreadCount = 0;

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }
  function num() {
    for (var i = 0; i < arguments.length; i += 1) {
      var v = arguments[i];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }
  function str(v) {
    return typeof v === 'string' && v ? v : null;
  }
  function vw() {
    return window.innerWidth;
  }
  function vh() {
    return window.innerHeight;
  }

  function safeBottom() {
    try {
      var probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;bottom:env(safe-area-inset-bottom);width:0;height:0;';
      document.body.appendChild(probe);
      var value = parseFloat(window.getComputedStyle(probe).bottom) || 0;
      document.body.removeChild(probe);
      return value;
    } catch (e) {
      return 0;
    }
  }

  function effColor() {
    return attrs.color || str(theme.bubbleColor) || DEFAULT_COLOR;
  }
  function effIcon() {
    return attrs.icon || str(theme.bubbleIcon);
  }
  function effPosition() {
    if (attrs.position === 'left' || attrs.position === 'right') return attrs.position;
    return theme.position === 'left' ? 'left' : 'right';
  }
  function effSize() {
    return clamp(num(theme.launcherSize, 56), 48, 80);
  }
  function effWidth() {
    return clamp(num(attrs.width, theme.windowWidth, 380), 320, 560);
  }
  function effHeight() {
    return clamp(num(attrs.height, theme.windowHeight, 600), 400, 820);
  }
  function effRadius() {
    return clamp(num(theme.radius, 16), 0, 28);
  }
  function effOpacity() {
    return clamp(num(theme.opacity, 1), 0.4, 1);
  }
  function effAnimation() {
    var a = theme.animationIn;
    return a === 'none' || a === 'fade' || a === 'slide' || a === 'pop' ? a : 'slide';
  }
  function shadowFor(kind) {
    var level = theme.shadow || 'medium';
    if (level === 'none') return 'none';
    if (kind === 'window') {
      if (level === 'soft') return '0 8px 24px rgba(0,0,0,0.12)';
      if (level === 'strong') return '0 18px 60px rgba(0,0,0,0.30)';
      return '0 12px 40px rgba(0,0,0,0.18)';
    }
    if (level === 'soft') return '0 4px 12px rgba(0,0,0,0.16)';
    if (level === 'strong') return '0 10px 30px rgba(0,0,0,0.35)';
    return '0 6px 20px rgba(0,0,0,0.25)';
  }
  function isMobile() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 480px)').matches;
  }
  function isImageIcon(icon) {
    return icon && /^(https?:\/\/|data:image\/)/.test(icon);
  }

  // ---------- launcher position

  function defaultPos() {
    var size = effSize();
    var offX = clamp(num(theme.offsetX, 20), 0, 300);
    var offY = clamp(num(theme.offsetY, 20), 0, 300);
    var left = effPosition() === 'right' ? vw() - size - offX : offX;
    var top = vh() - size - offY - safeBottom();
    return { left: left, top: top };
  }

  function clampPos(p) {
    var size = effSize();
    return {
      left: clamp(p.left, 8, Math.max(8, vw() - size - 8)),
      top: clamp(p.top, 8, Math.max(8, vh() - size - 8)),
    };
  }


  function currentPos() {
    return clampPos(sessionPos || defaultPos());
  }

  // ---------- launcher render

  function renderLauncherIcon() {
    launcher.textContent = '';
    if (state.opened) {
      launcher.textContent = '\u2715';
      return;
    }
    var icon = effIcon();
    if (isImageIcon(icon)) {
      var img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      img.style.cssText = 'width:60%;height:60%;object-fit:contain;border-radius:50%;pointer-events:none';
      launcher.appendChild(img);
    } else {
      launcher.textContent = icon || DEFAULT_ICON;
    }
  }

  function applyLabel() {
    var label = str(theme.launcherLabel);
    if (!label || state.opened) {
      if (labelEl && labelEl.parentNode) labelEl.parentNode.removeChild(labelEl);
      return;
    }
    var size = effSize();
    var pos = currentPos();
    if (!labelEl) {
      labelEl = document.createElement('button');
      labelEl.type = 'button';
      labelEl.addEventListener('click', function () {
        toggle();
      });
    }
    labelEl.textContent = label;
    var onLeftHalf = pos.left < vw() / 2;
    labelEl.style.cssText = [
      'position:fixed',
      'top:' + (pos.top + size / 2) + 'px',
      onLeftHalf ? 'left:' + (pos.left + size + 10) + 'px' : 'right:' + (vw() - pos.left + 10) + 'px',
      'transform:translateY(-50%)',
      'visibility:visible',
      'max-width:220px',
      'padding:8px 14px',
      'border:none',
      'border-radius:999px',
      'background:' + effColor(),
      'color:#fff',
      'font-size:13px',
      'line-height:1.3',
      'cursor:pointer',
      'box-shadow:' + shadowFor('launcher'),
      'z-index:' + Z,
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'transition:opacity .25s ease',
    ].join(';');
    if (!labelEl.parentNode) document.body.appendChild(labelEl);
  }

  // ---------- звук «пришло сообщение» (играет верхняя страница)
  // На мобильных iOS Safari не наследует активацию пользователя в iframe —
  // поэтому звук играет сам сайт после первого касания, а виджет только
  // просит его об этом (sitebot:sound). Web Audio, без файлов.
  var soundCtx = null;
  function soundContext() {
    if (soundCtx) return soundCtx;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      soundCtx = new Ctor();
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (e) {
        // iOS < 16.4 — системное поведение
      }
      return soundCtx;
    } catch (e) {
      return null;
    }
  }
  function warmUpSound(ctx) {
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.03);
    } catch (e) {
      // ignore
    }
  }
  function playChime() {
    var ctx = soundContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        ctx.resume();
      } catch (e) {
        // ещё заблокирован — сыграет после первого касания
      }
    }
    try {
      var start = ctx.currentTime + 0.01;
      var notes = [880, 1318.5];
      for (var i = 0; i < notes.length; i++) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = notes[i];
        var at = start + i * 0.13;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.12, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.4);
      }
    } catch (e) {
      // звук необязателен
    }
  }
  (function installSoundUnlock() {
    if (typeof window.addEventListener !== 'function') return;
    var events = ['pointerdown', 'touchstart', 'keydown', 'click'];
    var handler = function () {
      var ctx = soundContext();
      if (!ctx) return;
      warmUpSound(ctx);
      var release = function () {
        if (ctx.state !== 'running') return;
        for (var i = 0; i < events.length; i++) {
          window.removeEventListener(events[i], handler, true);
        }
      };
      if (ctx.state === 'suspended') {
        try {
          ctx.resume().then(release).catch(function () {});
        } catch (e) {
          release();
        }
      } else {
        release();
      }
    };
    for (var i = 0; i < events.length; i++) {
      window.addEventListener(events[i], handler, true);
    }
  })();

  function notifyFrame(type) {
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ type: type }, apiOrigin);
    } catch (e) {
      // ignore
    }
  }

  /** Attention while unread > 0: the launcher pulses and a red ring radiates.
   *  Web Animations API: независимо от системных настроек движения, не зависит
   *  от <style>-инъекций (CSP) и переживает сбросы cssText. */
  var pulseAnims = [];
  var ringEl = null;

  function positionRing() {
    if (!ringEl) return;
    var size = effSize();
    var pos = currentPos();
    ringEl.style.left = pos.left + 'px';
    ringEl.style.top = pos.top + 'px';
    ringEl.style.width = size + 'px';
    ringEl.style.height = size + 'px';
  }

  function startAttention() {
    if (typeof launcher.animate !== 'function') return;
    if (pulseAnims.length === 0) {
      try {
        pulseAnims.push(
          launcher.animate(
            [
              { transform: 'scale(1)' },
              { transform: 'scale(1.12)' },
              { transform: 'scale(1)' },
            ],
            { duration: 1500, easing: 'ease-in-out', iterations: Infinity },
          ),
        );
      } catch (e) {
        // ignore
      }
      if (badgeEl) {
        try {
          pulseAnims.push(
            badgeEl.animate(
              [
                { transform: 'scale(1)' },
                { transform: 'scale(1.25)' },
                { transform: 'scale(1)' },
              ],
              { duration: 1500, easing: 'ease-in-out', iterations: Infinity },
            ),
          );
        } catch (e) {
          // ignore
        }
      }
    }
    if (!ringEl) {
      ringEl = document.createElement('div');
      ringEl.setAttribute('aria-hidden', 'true');
      ringEl.style.cssText = [
        'position:fixed',
        'box-sizing:border-box',
        'border:3px solid rgba(239,68,68,0.85)',
        'border-radius:50%',
        'pointer-events:none',
        'z-index:' + (parseInt(Z, 10) - 1),
      ].join(';');
      document.body.appendChild(ringEl);
      positionRing();
      try {
        pulseAnims.push(
          ringEl.animate(
            [
              { transform: 'scale(1)', opacity: 0.9 },
              { transform: 'scale(1.6)', opacity: 0 },
            ],
            { duration: 1500, easing: 'ease-out', iterations: Infinity },
          ),
        );
      } catch (e) {
        // ignore
      }
    }
  }

  function stopAttention() {
    for (var i = 0; i < pulseAnims.length; i++) {
      try {
        pulseAnims[i].cancel();
      } catch (e) {
        // ignore
      }
    }
    pulseAnims = [];
    if (ringEl && ringEl.parentNode) ringEl.parentNode.removeChild(ringEl);
    ringEl = null;
  }

  function positionBadge() {
    if (!badgeEl) return;
    var size = effSize();
    var pos = currentPos();
    badgeEl.style.left = pos.left + size - 14 + 'px';
    badgeEl.style.top = pos.top - 8 + 'px';
  }

  /** Unread counter on the launcher (touches received while collapsed). */
  function updateBadge(count) {
    unreadCount = typeof count === 'number' && count > 0 ? Math.floor(count) : 0;
    if (unreadCount <= 0) {
      if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
      badgeEl = null;
      stopAttention();
      return;
    }
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.setAttribute('aria-hidden', 'true');
      badgeEl.style.cssText = [
        'position:fixed',
        'min-width:20px',
        'height:20px',
        'padding:0 5px',
        'border-radius:999px',
        'background:#ef4444',
        'color:#fff',
        'font-size:12px',
        'font-weight:600',
        'line-height:18px',
        'text-align:center',
        'border:2px solid #fff',
        'box-shadow:0 2px 8px rgba(0,0,0,0.28)',
        'box-sizing:border-box',
        'z-index:' + Z,
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(badgeEl);
    }
    badgeEl.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    positionBadge();
    startAttention();
  }

  function applyLauncher() {
    var size = effSize();
    var pos = currentPos();
    launcher.style.cssText = [
      'position:fixed',
      'left:' + pos.left + 'px',
      'top:' + pos.top + 'px',
      'width:' + size + 'px',
      'height:' + size + 'px',
      'border-radius:50%',
      'border:none',
      'background:' + effColor(),
      'color:#fff',
      'font-size:' + Math.round(size / 2.3) + 'px',
      'line-height:1',
      'cursor:grab',
      'box-shadow:' + shadowFor('launcher'),
      'opacity:' + effOpacity(),
      'z-index:' + Z,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:0',
      'touch-action:none',
      'user-select:none',
      '-webkit-user-select:none',
      'transition:transform .18s ease, opacity .25s ease',
    ].join(';');
    renderLauncherIcon();
    applyLabel();
    positionBadge();
    positionRing();
    if (teaser) positionTeaser();
  }

  function playEntrance(el) {
    var anim = effAnimation();
    if (anim === 'none') return;
    if (anim === 'fade') {
      el.style.opacity = '0';
    } else if (anim === 'slide') {
      el.style.opacity = '0';
      el.style.transform = 'translateY(16px)';
    } else if (anim === 'pop') {
      el.style.opacity = '0';
      el.style.transform = 'scale(0.5)';
    }
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        el.style.transition = 'transform .3s cubic-bezier(.2,.8,.3,1.08), opacity .3s ease';
        el.style.opacity = String(el === launcher ? effOpacity() : 1);
        el.style.transform = 'none';
      });
    });
  }

  var initDone = false;
  function finishInit() {
    if (initDone) return;
    initDone = true;
    if (!state.entrancePlayed) {
      state.entrancePlayed = true;
      playEntrance(launcher);
    }
  }

  // ---------- drag (also used as tap on touch devices)

  function initDrag() {
    var startX = 0;
    var startY = 0;
    var startLeft = 0;
    var startTop = 0;
    var moved = false;
    var touchInput = false;
    var lastTouchAt = 0;

    function onMove(e) {
      if (!state.dragging) return;
      var p = e.touches ? e.touches[0] : e;
      var dx = p.clientX - startX;
      var dy = p.clientY - startY;
      // Порог для пальца больше: лёгкое смещение при касании — это тап,
      // а не перетаскивание (с 4 px кнопка «не нажималась» на телефоне).
      var threshold = touchInput ? 12 : 4;
      if (Math.abs(dx) + Math.abs(dy) > threshold) moved = true;
      var np = clampPos({ left: startLeft + dx, top: startTop + dy });
      sessionPos = np;
      launcher.style.left = np.left + 'px';
      launcher.style.top = np.top + 'px';
      positionRing();
      if (labelEl) labelEl.style.visibility = 'hidden';
      if (teaser) teaser.style.display = 'none';
      if (e.cancelable) e.preventDefault();
    }

    function onUp() {
      if (!state.dragging) return;
      state.dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      launcher.style.cursor = 'grab';
      var left = parseFloat(launcher.style.left);
      var top = parseFloat(launcher.style.top);
      if (isFinite(left) && isFinite(top)) {
        sessionPos = { left: left, top: top };
      }
      applyLauncher();
      if (teaser) {
        teaser.style.display = '';
        positionTeaser();
      }
      if (frameWrap) applyFrame();
      if (moved) {
        // Перетащили: синтетический click после касания приходит позже —
        // окно побольше, чтобы виджет не «открылся» случайно после драга.
        state.suppressClick = true;
        window.setTimeout(function () {
          state.suppressClick = false;
        }, touchInput ? 500 : 120);
      } else if (touchInput) {
        // Тап по кнопке: открываем/закрываем здесь же и гасим синтетический
        // click (и совместимостные mouse-события после касания).
        state.suppressClick = true;
        window.setTimeout(function () {
          state.suppressClick = false;
        }, 500);
        toggle();
      }
    }

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      var isTouch = Boolean(e.touches);
      var now = Date.now();
      // После касания браузер шлёт совместимостные mouse-события — не даём
      // им заново заводить перетаскивание (из-за этого тап на телефоне
      // иногда «проглатывался»).
      if (!isTouch && now - lastTouchAt < 800) return;
      if (isTouch) lastTouchAt = now;
      state.dragging = true;
      moved = false;
      touchInput = isTouch;
      var p = e.touches ? e.touches[0] : e;
      startX = p.clientX;
      startY = p.clientY;
      var pos = currentPos();
      startLeft = pos.left;
      startTop = pos.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      if (e.cancelable) e.preventDefault();
    }

    launcher.addEventListener('mousedown', onDown);
    launcher.addEventListener('touchstart', onDown, { passive: false });
  }

  // ---------- chat window: shadow layer > clip layer > iframe
  // The rounded clip is applied by a dedicated, composited layer
  // (translateZ + webkit mask) — this removes the white corner fringes
  // that a plain border-radius + overflow:hidden on an iframe produces.

  function moveWindow(dx, dy) {
    if (!state.opened || isMobile() || !frameWrap) return;
    if (typeof dx !== 'number' || typeof dy !== 'number') return;
    var rect = frameWrap.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;
    var left = clamp(rect.left + dx, 8, Math.max(8, vw() - w - 8));
    var top = clamp(rect.top + dy, 8, Math.max(8, vh() - h - 8));
    state.windowPos = { left: left, top: top };
    frameWrap.style.left = left + 'px';
    frameWrap.style.top = top + 'px';
  }

  function createFrame() {
    frameWrap = document.createElement('div'); // outer: shadow + geometry
    frameClip = document.createElement('div'); // inner: the rounded clip
    frame = document.createElement('iframe');
    frame.src = apiOrigin + '/embed/' + encodeURIComponent(botKey);
    frame.title = attrs.label;
    frame.setAttribute('allow', 'clipboard-write; autoplay');
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:#fff;';
    frameClip.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'width:100%',
      'height:100%',
      'overflow:hidden',
      'border-radius:inherit',
      'transform:translateZ(0)',
      'background:#fff',
      '-webkit-mask-image:-webkit-radial-gradient(#fff,#000)',
    ].join(';');
    frameClip.appendChild(frame);
    frameWrap.appendChild(frameClip);
    document.body.appendChild(frameWrap);
    frameWrap.style.display = 'none';
    applyFrame();
  }

  function applyFrame() {
    if (!frameWrap) return;
    if (frameClip) {
      var clipRadius = isMobile() ? 0 : effRadius();
      frameClip.style.clipPath = 'inset(0px round ' + clipRadius + 'px)';
      frameClip.style.webkitClipPath = 'inset(0px round ' + clipRadius + 'px)';
    }
    if (isMobile()) {
      frameWrap.style.position = 'fixed';
      frameWrap.style.left = '0';
      frameWrap.style.top = '0';
      frameWrap.style.right = '0';
      frameWrap.style.bottom = '0';
      frameWrap.style.width = '100%';
      frameWrap.style.height = '100%';
      frameWrap.style.borderRadius = '0px';
      frameWrap.style.boxShadow = 'none';
      frameWrap.style.overflow = 'visible';
      frameWrap.style.background = 'transparent';
      frameWrap.style.zIndex = Z;
      return;
    }
    var w = Math.min(effWidth(), vw() - 40);
    var h = Math.min(effHeight(), vh() - 120);
    var size = effSize();
    var pos = currentPos();
    var left = clamp(pos.left + size / 2 - w / 2, 8, Math.max(8, vw() - w - 8));
    var above = pos.top > h + 16;
    var top = above
      ? pos.top - h - 12
      : clamp(pos.top + size + 12, 8, Math.max(8, vh() - h - 8));
    if (state.windowPos) {
      left = clamp(state.windowPos.left, 8, Math.max(8, vw() - w - 8));
      top = clamp(state.windowPos.top, 8, Math.max(8, vh() - h - 8));
      state.windowPos = { left: left, top: top };
    }
    frameWrap.style.position = 'fixed';
    frameWrap.style.left = left + 'px';
    frameWrap.style.top = top + 'px';
    frameWrap.style.right = 'auto';
    frameWrap.style.bottom = 'auto';
    frameWrap.style.width = w + 'px';
    frameWrap.style.height = h + 'px';
    frameWrap.style.borderRadius = effRadius() + 'px';
    frameWrap.style.boxShadow = shadowFor('window');
    frameWrap.style.overflow = 'visible';
    frameWrap.style.background = 'transparent';
    frameWrap.style.zIndex = Z;
  }

  function animateOpen() {
    frameWrap.style.display = 'block';
    var anim = effAnimation();
    if (anim === 'none') {
      frameWrap.style.opacity = '1';
      frameWrap.style.transform = 'none';
      return;
    }
    var size = effSize();
    var pos = currentPos();
    var rect = frameWrap.getBoundingClientRect();
    var originX = pos.left + size / 2 < rect.left + rect.width / 2 ? '0%' : '100%';
    var originY = pos.top + size / 2 < rect.top + rect.height / 2 ? '0%' : '100%';
    frameWrap.style.transformOrigin = originX + ' ' + originY;
    frameWrap.style.transition = 'none';
    frameWrap.style.opacity = '0';
    frameWrap.style.transform = anim === 'pop' ? 'scale(0.9)' : 'translateY(14px) scale(0.99)';
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        frameWrap.style.transition = 'opacity .22s ease, transform .26s cubic-bezier(.2,.8,.3,1.05)';
        frameWrap.style.opacity = '1';
        frameWrap.style.transform = 'scale(1) translateY(0)';
        window.setTimeout(function () {
          if (!state.opened) return;
          frameWrap.style.transition = 'none';
          frameWrap.style.transform = 'none';
          frameWrap.style.opacity = '1';
        }, 340);
      });
    });
  }

  function animateClose() {
    var anim = effAnimation();
    if (anim === 'none') {
      frameWrap.style.display = 'none';
      return;
    }
    frameWrap.style.transition = 'opacity .18s ease, transform .2s ease';
    frameWrap.style.opacity = '0';
    frameWrap.style.transform = anim === 'pop' ? 'scale(0.94)' : 'translateY(10px) scale(0.99)';
    window.setTimeout(function () {
      if (!state.opened) frameWrap.style.display = 'none';
    }, 210);
  }

  function toggle() {
    if (!frameWrap) createFrame();
    state.opened = !state.opened;
    if (state.opened) {
      hideTeaser(false);
      applyFrame();
      animateOpen();
      updateBadge(0);
      notifyFrame('sitebot:chat-opened');
    } else {
      animateClose();
      notifyFrame('sitebot:chat-closed');
    }
    renderLauncherIcon();
    applyLabel();
  }

  // ---------- proactive teaser

  function hideTeaser(persist) {
    if (teaser && teaser.parentNode) teaser.parentNode.removeChild(teaser);
    teaser = null;
    if (persist) {
      state.teaserDismissed = true;
      try {
        window.localStorage.setItem(TEASER_KEY, '1');
      } catch (e) {
        // ignore
      }
    }
  }

  function positionTeaser() {
    if (!teaser) return;
    var size = effSize();
    var pos = currentPos();
    var onLeftHalf = pos.left < vw() / 2;
    teaser.style.top = pos.top - 12 + 'px';
    teaser.style.transform = 'translateY(-100%)';
    if (onLeftHalf) {
      teaser.style.left = pos.left + 'px';
      teaser.style.right = 'auto';
    } else {
      teaser.style.left = 'auto';
      teaser.style.right = vw() - pos.left - size + 'px';
    }
  }

  function showTeaser() {
    if (state.opened || state.teaserDismissed || teaser) return;
    var proactive = theme.proactive;
    if (!proactive || proactive.enabled !== true) return;
    var text = str(proactive.text) || 'Здравствуйте! Подскажу что-нибудь?';
    teaser = document.createElement('div');
    teaser.style.cssText = [
      'position:fixed',
      'max-width:260px',
      'padding:12px 30px 12px 14px',
      'border-radius:14px',
      'background:#fff',
      'color:#1f2937',
      'font-size:13px',
      'line-height:1.45',
      'box-shadow:' + shadowFor('window'),
      'cursor:pointer',
      'z-index:' + Z,
      'transition:opacity .25s ease',
    ].join(';');
    var textEl = document.createElement('span');
    textEl.textContent = text;
    teaser.appendChild(textEl);
    var close = document.createElement('span');
    close.textContent = '\u2715';
    close.style.cssText = 'position:absolute;top:6px;right:8px;font-size:11px;color:#94a3b8;cursor:pointer;padding:2px';
    close.addEventListener('click', function (event) {
      if (event && event.stopPropagation) event.stopPropagation();
      hideTeaser(true);
    });
    teaser.appendChild(close);
    teaser.addEventListener('click', function () {
      hideTeaser(true);
      if (!state.opened) toggle();
    });
    document.body.appendChild(teaser);
    positionTeaser();
    playEntrance(teaser);
  }

  // ---------- wiring

  launcher.addEventListener('click', function () {
    if (state.suppressClick || state.dragging) return;
    toggle();
  });
  initDrag();

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function () {
      applyLauncher();
      if (frameWrap) applyFrame();
    });
    // The chat's minimize control (embed iframe) asks us to collapse.
    window.addEventListener('message', function (event) {
      if (event.origin !== apiOrigin) return;
      var data = event.data;
      if (!data) return;
      if (data.type === 'sitebot:minimize' && state.opened) {
        toggle();
      } else if (data.type === 'sitebot:unread') {
        // Only the counter + pulse — bot touches never pop a text bubble.
        updateBadge(typeof data.count === 'number' ? data.count : 0);
      } else if (data.type === 'sitebot:sound') {
        // Виджет просит озвучить новое сообщение — звук играет верхняя страница.
        if (data.sound !== false) playChime();
      } else if (data.type === 'sitebot:hello') {
        // Рукопожатие: сообщаем виджету, что звук здесь поддерживается.
        try {
          if (event.source && event.source.postMessage) {
            event.source.postMessage({ type: 'sitebot:loader', sound: true }, '*');
          }
        } catch (e) {
          // ignore
        }
      } else if (data.type === 'sitebot:move') {
        moveWindow(data.dx, data.dy);
      } else if (data.type === 'sitebot:move-reset') {
        state.windowPos = null;
        if (frameWrap) applyFrame();
      }
    });
  }

  applyLauncher();
  document.body.appendChild(launcher);
  window.setTimeout(finishInit, 500);

  try {
    if (window.localStorage.getItem(TEASER_KEY) === '1') {
      state.teaserDismissed = true;
    }
  } catch (e) {
    // ignore
  }

  try {
    fetch(apiOrigin + '/api/bot?key=' + encodeURIComponent(botKey))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        var incoming = data && data.bots && data.bots[0] && data.bots[0].theme;
        if (incoming) theme = incoming;
        applyLauncher();
        finishInit();
        if (theme.proactive && theme.proactive.enabled === true && !state.teaserDismissed) {
          var delay = num(theme.proactive.delaySeconds, 8) * 1000;
          window.setTimeout(showTeaser, Math.max(3000, Math.min(60000, delay)));
        }
      })
      .catch(function () {
        finishInit();
      });
  } catch (e) {
    finishInit();
  }
})();
