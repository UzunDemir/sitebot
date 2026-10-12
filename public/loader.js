/**
 * sitebot embed loader.
 *
 * Usage on any website:
 *   <script src="https://sitebot-nu.vercel.app/loader.js"
 *           data-bot="pk_..." async></script>
 *
 * Optional attributes (override the bot's theme for this embed):
 *   data-color="#4f46e5"      launcher color
 *   data-icon="🛎"            launcher icon (emoji or image URL)
 *   data-position="left"      launcher on the left (default: right)
 *   data-label="Онлайн-чат"   aria label
 *
 * The launcher theme (color/icon) is loaded from /api/bot?key= (CORS-open).
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
  var explicitColor = script.getAttribute('data-color');
  var explicitIcon = script.getAttribute('data-icon');
  var position = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var label = script.getAttribute('data-label') || 'Открыть чат';
  var DEFAULT_COLOR = '#4f46e5';
  var Z = '2147483000';

  var theme = { bubbleColor: explicitColor || null, bubbleIcon: explicitIcon || null };
  var opened = false;
  var frame = null;

  var button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);

  function isMobile() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 480px)').matches;
  }

  function renderButton() {
    button.textContent = '';
    var icon = theme.bubbleIcon;
    if (opened) {
      button.textContent = '\u2715';
      return;
    }
    if (icon && /^(https?:\/\/|data:image\/)/.test(icon)) {
      var img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      img.style.cssText = 'width:60%;height:60%;object-fit:contain;border-radius:50%';
      button.appendChild(img);
    } else {
      button.textContent = icon || '\uD83D\uDCAC';
    }
  }

  function applyButton() {
    var color = theme.bubbleColor || DEFAULT_COLOR;
    button.style.cssText = [
      'position:fixed',
      'bottom:calc(20px + env(safe-area-inset-bottom))',
      position + ':20px',
      'width:56px',
      'height:56px',
      'border-radius:50%',
      'border:none',
      'background:' + color,
      'color:#fff',
      'font-size:24px',
      'line-height:1',
      'cursor:pointer',
      'box-shadow:0 6px 20px rgba(0,0,0,0.25)',
      'z-index:' + Z,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:0',
    ].join(';');
    renderButton();
  }

  function applyFrame() {
    if (!frame) return;
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
        position + ':20px',
        'width:380px',
        'max-width:calc(100vw - 40px)',
        'height:min(600px, calc(100vh - 120px))',
        'border:none',
        'border-radius:16px',
        'box-shadow:0 12px 40px rgba(0,0,0,0.18)',
        'background:#fff',
        'z-index:' + Z,
      ].join(';');
    }
    frame.style.display = opened ? 'block' : 'none';
  }

  function createFrame() {
    frame = document.createElement('iframe');
    frame.src = apiOrigin + '/embed/' + encodeURIComponent(botKey);
    frame.title = label;
    frame.setAttribute('allow', 'clipboard-write');
    document.body.appendChild(frame);
    applyFrame();
  }

  button.addEventListener('click', function () {
    if (!frame) createFrame();
    opened = !opened;
    applyFrame();
    renderButton();
  });

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function () {
      if (frame) applyFrame();
    });
  }

  applyButton();
  document.body.appendChild(button);

  // Launcher theme from the bot (public, CORS-enabled). Explicit data-*
  // attributes win over the server-side theme.
  try {
    fetch(apiOrigin + '/api/bot?key=' + encodeURIComponent(botKey))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        var t = data && data.bots && data.bots[0] && data.bots[0].theme;
        if (!t) return;
        var changed = false;
        if (!explicitColor && t.bubbleColor) {
          theme.bubbleColor = t.bubbleColor;
          changed = true;
        }
        if (!explicitIcon && t.bubbleIcon) {
          theme.bubbleIcon = t.bubbleIcon;
          changed = true;
        }
        if (changed) applyButton();
      })
      .catch(function () {});
  } catch (e) {
    // no fetch — keep the default launcher
  }
})();
