// Runtime API-surface check for installed packages (no network calls).
const lines = [];

try {
  const ai = await import('ai');
  const names = [
    'embed',
    'embedMany',
    'streamText',
    'convertToModelMessages',
    'createUIMessageStream',
    'createUIMessageStreamResponse',
    'toUIMessageStream',
    'DefaultChatTransport',
  ];
  lines.push('AI: ' + names.map((n) => n + '=' + (n in ai ? 'ok' : 'MISSING')).join(' '));
} catch (e) {
  lines.push('AI: ERROR ' + e.message);
}

try {
  const { createGoogle } = await import('@ai-sdk/google');
  const g = createGoogle({ apiKey: 'test' });
  const emb = g.textEmbeddingModel('gemini-embedding-001', { outputDimensionality: 1536 });
  lines.push('GOOGLE: ok modelId=' + emb.modelId);
} catch (e) {
  lines.push('GOOGLE: ERROR ' + e.message);
}

try {
  const { createDeepSeek } = await import('@ai-sdk/deepseek');
  const d = createDeepSeek({ apiKey: 'test' });
  const m = d('deepseek-flash');
  lines.push('DEEPSEEK: ok modelId=' + m.modelId);
} catch (e) {
  lines.push('DEEPSEEK: ERROR ' + e.message);
}

console.log(lines.join('\n'));
