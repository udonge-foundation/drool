export function formatModelName(model: string): string {
  const lower = model.toLowerCase();

  // Claude models
  if (lower.includes('opus')) {
    if (lower.includes('4-5') || lower.includes('4.5'))
      return 'Claude Opus 4.5';
    return 'Claude Opus';
  }
  if (lower.includes('sonnet')) {
    if (lower.includes('4-5') || lower.includes('4.5'))
      return 'Claude Sonnet 4.5';
    if (lower.includes('3-5') || lower.includes('3.5'))
      return 'Claude Sonnet 3.5';
    return 'Claude Sonnet';
  }
  if (lower.includes('haiku')) {
    if (lower.includes('4-5') || lower.includes('4.5'))
      return 'Claude Haiku 4.5';
    if (lower.includes('3-5') || lower.includes('3.5'))
      return 'Claude Haiku 3.5';
    return 'Claude Haiku';
  }

  // GPT models
  if (lower.includes('codex-max')) return 'GPT 5.1 Codex Max';
  if (lower.includes('codex') && lower.includes('5.1')) return 'GPT 5.1 Codex';
  if (lower.includes('gpt-5.2') || /gpt.*5\.2/.exec(lower)) return 'GPT 5.2';
  if (lower.includes('gpt-5.1') || /gpt.*5\.1/.exec(lower)) return 'GPT 5.1';
  if (lower.includes('gpt-4o')) return 'GPT-4o';
  if (lower.includes('gpt-4')) return 'GPT-4';
  if (lower.includes('o1')) return 'o1';
  if (lower.includes('o3')) return 'o3';
  if (lower.includes('orion')) return 'Orion';

  // Gemini
  if (lower.includes('gemini-3') || lower.includes('gemini 3')) {
    if (lower.includes('flash')) return 'Gemini 3 Flash';
    return 'Gemini 3';
  }
  if (lower.includes('gemini-2')) return 'Gemini 2';
  if (lower.includes('gemini')) return 'Gemini';

  // Provider names
  if (model === 'openai') return 'OpenAI';
  if (model === 'anthropic') return 'Anthropic';
  if (model === 'google') return 'Google';

  // Other
  if (lower.includes('generic-chat') || lower.includes('custom:'))
    return 'BYOK';
  if (lower.includes('kimi')) return 'Kimi';
  if (model === 'unknown') return 'Unknown';

  return model.length > 24 ? `${model.slice(0, 24)}...` : model;
}
