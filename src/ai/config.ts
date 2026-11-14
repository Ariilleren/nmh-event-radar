import { AiError, type AiMode } from './types';

export function readAiMode(env: Record<string, string | undefined> = process.env): AiMode {
  const mode = (env.AI_MODE || 'DEMO').trim().toUpperCase();
  if (mode !== 'DEMO' && mode !== 'LIVE') {
    throw new AiError('AI_CONFIG', 'AI_MODE должен быть DEMO или LIVE.', 503);
  }
  return mode;
}

export function readLiveConfig(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.AI_API_KEY?.trim();
  const model = env.AI_MODEL?.trim();
  if (!apiKey) throw new AiError('AI_CONFIG', 'Режим LIVE: укажите AI_API_KEY в серверном .env.', 503);
  if (!model) throw new AiError('AI_CONFIG', 'Режим LIVE: укажите доступную вашему аккаунту модель в AI_MODEL.', 503);
  let base: URL;
  try { base = new URL(env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1'); }
  catch { throw new AiError('AI_CONFIG', 'AI_BASE_URL должен быть адресом совместимого API, например https://api.openai.com/v1.', 503); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) || base.username || base.password || base.search || base.hash) {
    throw new AiError('AI_CONFIG', 'AI_BASE_URL: нужен HTTPS (HTTP разрешён только для localhost), без пароля, query и fragment.', 503);
  }
  return { apiKey, model, endpoint: `${base.href.replace(/\/+$/, '')}/chat/completions` };
}

export function getAIStatus(env: Record<string, string | undefined> = process.env) {
  try {
    const mode = readAiMode(env);
    if (mode === 'DEMO') return {
      mode, model: null, configured: true, issues: [] as string[],
      message: 'Демонстрационный режим — ответ подготовлен заранее. Новые тексты требуют LIVE.',
    };
    const config = readLiveConfig(env);
    return {
      mode, model: config.model, configured: true, issues: [] as string[],
      message: 'LIVE настроен. Наличие настроек не подтверждает доступ к API: выполните проверку соединения.',
    };
  } catch (error) {
    return {
      mode: (env.AI_MODE || 'DEMO').trim().toUpperCase(), model: null, configured: false,
      issues: [error instanceof AiError ? error.message : 'Не удалось проверить настройки AI.'],
      message: 'AI недоступен до исправления серверной конфигурации.',
    };
  }
}
