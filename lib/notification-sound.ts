/**
 * Звук нового сообщения в виджете: короткий мягкий сигнал на Web Audio —
 * без файлов и внешних ресурсов.
 *
 * Разблокировка звука. Браузеры (особенно мобильные) разрешают звук только
 * после действия пользователя. installMessageSoundUnlock() вешает
 * «разбудильник» на первое касание/клик/клавишу ПРЯМО В ЭТОМ документе и
 * снимает слушателей, когда контекст запустился. iOS Safari не наследует
 * активацию из родительской страницы в iframe — поэтому при встроенном
 * виджете звук дополнительно играет верхняя страница (loader).
 *
 * navigator.audioSession.type = 'playback' (iOS 16.4+) — звук играет и при
 * бесшумном режиме телефона; на старых iOS остаётся системное поведение.
 */

let sharedContext: AudioContext | null = null;
let unlockInstalled = false;

type AudioContextCtor = typeof AudioContext;

function audioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  try {
    const Ctor: AudioContextCtor | undefined =
      typeof window === 'undefined'
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return null;
    sharedContext = new Ctor();
    try {
      // iOS 16.4+: «playback» звучит даже при включённом бесшумном режиме.
      const session = (navigator as unknown as { audioSession?: { type?: string } }).audioSession;
      if (session) session.type = 'playback';
    } catch {
      // старые iOS/браузеры — системное поведение
    }
    return sharedContext;
  } catch {
    return null;
  }
}

/** Тихий «щелчок» (≈0): на iOS добивает разблокировку аудио-конвейера. */
function warmUp(ctx: AudioContext): void {
  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.03);
  } catch {
    // ignore
  }
}

/** Разбудить звук в этом документе (вызывать из жеста пользователя). */
export function unlockMessageSound(): void {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  warmUp(ctx);
}

/**
 * Одноразовая установка «разбудильника»: первое касание/клик/клавиша в этом
 * документе запускает аудио-контекст; слушатели снимаются, когда он запущен.
 */
export function installMessageSoundUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const events = ['pointerdown', 'touchstart', 'keydown', 'click'] as const;
  const handler = (): void => {
    const ctx = audioContext();
    if (!ctx) return;
    warmUp(ctx);
    const release = (): void => {
      if (ctx.state !== 'running') return;
      for (const event of events) {
        window.removeEventListener(event, handler, true);
      }
    };
    if (ctx.state === 'suspended') {
      void ctx.resume().then(release).catch(() => {});
    } else {
      release();
    }
  };
  for (const event of events) {
    window.addEventListener(event, handler, true);
  }
}

/** Короткий двухтоновый сигнал «пришло сообщение». Никогда не бросает. */
export function playMessageSound(): void {
  try {
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const start = ctx.currentTime + 0.01;
    const notes = [880, 1318.5]; // A5 → E6: мягкий «бинг»
    notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const at = start + index * 0.13;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.4);
    });
  } catch {
    // звук — необязательное украшение: молча пропускаем
  }
}
