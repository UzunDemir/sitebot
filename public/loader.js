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
 * Everything else (position, sizes, label, palette, dark mode, proactive
 * teaser) comes from the bot's theme via /api/bot (CORS-open).
 * On screens narrower than 480px the chat opens fullscreen with safe-area
 * insets. All widget styles are inline — the host page CSS cannot break it.
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
  var DEFAULT_COLOR = '#4f46e5';
  var DEFAULT_ICON = '\uD83D\uDCAC';
  var Z = '2147483000';

  var theme = {};
  var state = { opened: false, teaserDismissed: false };
  var frame = null;
  var teaser = null;
  var labelEl = null;
  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', attrs.label);

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function num(...values) {
    for (var i = 0; i < values.length; i += 1) {
      if (typeof values[i] === 'number' && isFinite(values[i])) return values[i];
    }
    return null;
  }

  function stringOrNull(value) {
    return typeof value === 'string' && value ? value : null;
  }

  function effColor() {
    return attrs.color || stringOrNull(theme.bubbleColor) || DEFAULT_COLOR;
  }
  function effIcon() {
    return attrs.icon || stringOrNull(theme.bubbleIcon);
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
  function launcherLabel() {
    return stringOrNull(theme.launcherLabel);
  }

  function isMobile() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 480px)').matches;
  }

  function isImageIcon(icon) {
    return icon && /^(https?:\/\/|data:image\/)/.test(icon);
  }

  function renderLauncher() {
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
      img.style.cssText = 'width:60%;height:60%;object-fit:contain;border-radius:50%';
      launcher.appendChild(img);
    } else {
      launcher.textContent = icon || DEFAULT_ICON;
    }
  }

  function applyLauncher() {
    var size = effSize();
    var side = effPosition();
    launcher.style.cssText = [
      'position:fixed',
      'bottom:calc(20px + env(safe-area-inset-bottom))',
      side + ':20px',
      'width:' + size + 'px',
      'height:' + size + 'px',
      'border-radius:50%',
      'border:none',
      'background:' + effColor(),
      'color:#fff',
      'font-size:' + Math.round(size / 2.3) + 'px',
      'line-height:1',
      'cursor:pointer',
      'box-shadow:0 6px 20px rgba(0,0,0,0.25)',
      'z-index:' + Z,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:0',
    ].join(';');
    renderLauncher();

    var label = launcherLabel();
    if (label && !state.opened) {
      if (!labelEl) {
        labelEl = document.createElement('button');
        labelEl.type = 'button';
        labelEl.addEventListener('click', function () {
          toggle();
        });
      }
      labelEl.textContent = label;
      labelEl.style.cssText = [
        'position:fixed',
        'bottom:calc(' + (20 + Math.round((size - 34) / 2)) + 'px + env(safe-area-inset-bottom))',
        side + ':' + (20 + size + 10) + 'px',
        'max-width:220px',
        'padding:8px 14px',
        'border:none',
        'border-radius:999px',
        'background:' + effColor(),
        'color:#fff',
        'font-size:13px',
        'line-height:1.3',
        'cursor:pointer',
        'box-shadow:0 6px 20px rgba(0,0,0,0.22)',
        'z-index:' + Z,
        'white-space:nowrap',
        'overflow:hidden',
        'text-overflow:ellipsis',
      ].join(';');
      if (!labelEl.parentNode) document.body.appendChild(labelEl);
    } else if (labelEl && labelEl.parentNode) {
      labelEl.parentNode.removeChild(labelEl);
    }
  }

  function applyFrame() {
    if (!frame) return;
    var side = effPosition();
    if (isMobile()) {
      frame.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'right:0',
        'bottom:0',
        'width:100%',
        'height:100%',
        'border:none',
        'border-radius:0',
        'background:#fff',
        'box-shadow:none',
        'z-index:' + Z,
        'padding-bottom:env(safe-area-inset-bottom)',
      ].join(';');
    } else {
      frame.style.cssText = [
        'position:fixed',
        'bottom:calc(88px + env(safe-area-inset-bottom))',
        side + ':20px',
        'width:' + effWidth() + 'px',
        'max-width:calc(100vw - 40px)',
        'height:min(' + effHeight() + 'px, calc(100vh - 120px))',
        'border:none',
        'border-radius:' + effRadius() + 'px',
        'box-shadow:0 12px 40px rgba(0,0,0,0.18)',
        'background:#fff',
        'z-index:' + Z,
      ].join(';');
    }
    frame.style.display = state.opened ? 'block' : 'none';
  }

  function hideTeaser(persist) {
    if (teaser && teaser.parentNode) teaser.parentNode.removeChild(teaser);
    teaser = null;
    if (persist) {
      state.teaserDismissed = true;
      try {
        window.localStorage.setItem('sitebot_teaser_' + botKey, '1');
      } catch (e) {
        // private mode — ignore
      }
    }
  }

  function showTeaser() {
    if (state.opened || state.teaserDismissed || teaser) return;
    var proactive = theme.proactive;
    if (!proactive || proactive.enabled !== true) return;
    var text = stringOrNull(proactive.text) || 'Здравствуйте! Подскажу что-нибудь?';
    var size = effSize();
    var side = effPosition();
    teaser = document.createElement('div');
    teaser.style.cssText = [
      'position:fixed',
      'bottom:calc(' + (20 + size + 14) + 'px + env(safe-area-inset-bottom))',
      side + ':20px',
      'max-width:260px',
      'padding:12px 30px 12px 14px',
      'border-radius:14px',
      'background:#fff',
      'color:#1f2937',
      'font-size:13px',
      'line-height:1.45',
      'box-shadow:0 10px 30px rgba(0,0,0,0.18)',
      'cursor:pointer',
      'z-index:' + Z,
    ].join(';');
    var textEl = document.createElement('span');
    textEl.textContent = text;
    teaser.appendChild(textEl);
    var close = document.createElement('span');
    close.textContent = '\u2715';
    close.style.cssText =
      'position:absolute;top:6px;right:8px;font-size:11px;color:#94a3b8;cursor:pointer;padding:2px';
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
  }

  function createFrame() {
    frame = document.createElement('iframe');
    frame.src = apiOrigin + '/embed/' + encodeURIComponent(botKey);
    frame.title = attrs.label;
    frame.setAttribute('allow', 'clipboard-write');
    document.body.appendChild(frame);
    applyFrame();
  }

  function toggle() {
    if (!frame) createFrame();
    state.opened = !state.opened;
    if (state.opened) hideTeaser(false);
    applyFrame();
    applyLauncher();
  }

  launcher.addEventListener('click', toggle);

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function () {
      if (frame) applyFrame();
      applyLauncher();
    });
  }

  applyLauncher();
  document.body.appendChild(launcher);

  try {
    if (window.localStorage.getItem('sitebot_teaser_' + botKey) === '1') {
      state.teaserDismissed = true;
    }
  } catch (e) {
    // private mode — ignore
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
        if (frame) applyFrame();
        if (theme.proactive && theme.proactive.enabled === true && !state.teaserDismissed) {
          var delay = num(theme.proactive.delaySeconds, 8) * 1000;
          window.setTimeout(showTeaser, Math.max(3000, Math.min(60000, delay)));
        }
      })
      .catch(function () {});
  } catch (e) {
    // no fetch — keep the default launcher
  }
})();
