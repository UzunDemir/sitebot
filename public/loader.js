/**
 * sitebot embed loader.
 *
 * Usage on any website:
 *   <script src="https://sitebot-nu.vercel.app/loader.js"
 *           data-bot="pk_..." async></script>
 *
 * Optional attributes:
 *   data-color="#4f46e5"      bubble / accent color
 *   data-position="left"      bubble on the left (default: right)
 *   data-label="Онлайн-чат"   aria label
 *
 * All widget styles are inline — the host page CSS cannot break the widget.
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

  var origin = new URL(script.src).origin;
  var color = script.getAttribute('data-color') || '#4f46e5';
  var position = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var label = script.getAttribute('data-label') || 'Открыть чат';
  var Z = '2147483000';

  var opened = false;
  var frame = null;
  var button = document.createElement('button');

  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.textContent = '💬';
  button.style.cssText = [
    'position:fixed',
    'bottom:20px',
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
  ].join(';');

  function createFrame() {
    frame = document.createElement('iframe');
    frame.src = origin + '/embed/' + encodeURIComponent(botKey);
    frame.title = label;
    frame.setAttribute('allow', 'clipboard-write');
    frame.style.cssText = [
      'position:fixed',
      'bottom:88px',
      position + ':20px',
      'width:380px',
      'max-width:calc(100vw - 40px)',
      'height:min(600px, calc(100vh - 120px))',
      'border:none',
      'border-radius:16px',
      'box-shadow:0 12px 40px rgba(0,0,0,0.18)',
      'background:#fff',
      'display:none',
      'z-index:' + Z,
    ].join(';');
    document.body.appendChild(frame);
  }

  button.addEventListener('click', function () {
    if (!frame) createFrame();
    opened = !opened;
    frame.style.display = opened ? 'block' : 'none';
    button.textContent = opened ? '✕' : '💬';
  });

  document.body.appendChild(button);
})();
