/**
 * Звук нового сообщения в виджете: короткий мягкий сигнал на Web Audio —
 * без файлов и внешних ресурсов. Браузеры разрешают звук только после первого
 * действия пользователя на странице: unlockMessageSound() «будит» аудио при
 * первом клике/нажатии, playMessageSound() тихо молчит, пока звук запрещён.
 */

let sharedContext: AudioContext | null = null;

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
    return sharedContext;
  } catch {
    return null;
  }
}

/** «Разбудить» звук после первого действия на странице (политика браузеров). */
export function unlockMessageSound(): void {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
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
