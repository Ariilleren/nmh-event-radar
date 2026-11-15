/**
 * Isolated, synthetic Gemini showcase. Default is read-only; --apply writes only
 * the separately owned presentation account. Sources are never published here.
 * --analyze runs the existing queue against the four published scenario posts.
 * Run from the repository: node --import tsx scripts/setup-showcase.mjs [--apply]
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { setGlobalProxyFromEnv } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from '../src/server/db.ts';
import { register, updateProfile, savePersonalLocation, logout, getProductState } from '../src/server/product.ts';
import { syncTelegram, analyzePendingNews } from '../src/server/news-pipeline.ts';
import { locationSchema } from '../src/domain/schemas.ts';

const root = new URL('../', import.meta.url);
const email = 'anna@threecups.example';
const legacyEmail = 'gemini-showcase@nmh-showcase.test';
const marker = 'nmh-gemini-showcase-v1';
const credentialsPath = new URL('../.local/showcase-credentials.json', import.meta.url);
const apply = process.argv.includes('--apply');
const analyze = process.argv.includes('--analyze');
setGlobalProxyFromEnv();
const sourceIds = ['22', '25', '23', '24']; // Published scenario 01, 02, 03, 04.
let registrationToken;

class SetupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
async function readCredentials() {
  try {
    const value = JSON.parse(await readFile(credentialsPath, 'utf8'));
    if (value.kind !== marker || ![email, legacyEmail].includes(value.email) || typeof value.password !== 'string' || value.password.length < 20) {
      throw new SetupError('CREDENTIALS_MISMATCH', 'Локальный файл доступа не принадлежит этому учебному набору.');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (left, right) => canonical(left) === canonical(right);
const ownsFields = (current, expected) => Object.entries(expected).every(([key, value]) => equal(current[key], value));

try {
  const bundle = JSON.parse(await readFile(new URL('docs/demo/presentation-2026-11-16/businesses.json', root), 'utf8'));
  const business = bundle.businesses.find(item => item.id === 'three-cups');
  if (!bundle.isSynthetic || !business || business.locations.length !== 3) {
    throw new SetupError('INVALID_PREPARED_DATA', 'Не найден подготовленный учебный бизнес с тремя точками.');
  }
  const profile = {
    ...business.profilePatch,
    name: 'Анна Соколова',
    businessName: 'Три чашки',
    about: business.profilePatch.about,
  };
  const locations = business.locations.map(item => locationSchema.parse({ ...item, name: item.name.split(' · ')[0], responsibleName: item.responsibleName.split(' · ')[0] }));
  const sourceQuery = {
    where: { channel: 'newsssss09', channelMessageId: { in: sourceIds } },
    select: { id: true, channelMessageId: true, url: true, versions: { orderBy: { version: 'desc' }, take: 1, select: { text: true } } },
  };
  let sources = await db.sourceMessage.findMany(sourceQuery);
  if (apply && sources.length !== sourceIds.length) {
    const imported = await syncTelegram();
    if (imported.error) throw new SetupError('SOURCE_UNAVAILABLE', 'Не удалось получить канал. Проверьте доступ к Telegram и повторите запуск.');
    sources = await db.sourceMessage.findMany(sourceQuery);
  }
  const missingSources = sourceIds.filter(id => !sources.some(source => source.channelMessageId === id && source.url === 'https://t.me/newsssss09/' + id));
  const publishedSources = sourceIds.flatMap((id, index) => {
    const source = sources.find(item => item.channelMessageId === id);
    return source ? [{ scenario: String(index + 1).padStart(2, '0'), url: source.url, explicitlySynthetic: /вымышлен|учебного показа/iu.test(source.versions[0]?.text || '') }] : [];
  });
  const credentials = await readCredentials();
  const byEmail = await db.user.findUnique({ where: { email } });
  const ownedUser = credentials?.userId ? await db.user.findUnique({ where: { id: credentials.userId } }) : null;
  if (byEmail && ownedUser && byEmail.id !== ownedUser.id) throw new SetupError('OWNERSHIP_UNCONFIRMED', 'Адрес профиля уже занят другим аккаунтом.');
  const existing = byEmail ?? ownedUser;
  if (existing && (!credentials?.userId || credentials.userId !== existing.id)) {
    throw new SetupError('OWNERSHIP_UNCONFIRMED', 'Адрес учебного аккаунта уже занят, а локальное подтверждение владения не совпадает. Существующий аккаунт не изменён.');
  }
  if (credentials?.userId && !existing) {
    throw new SetupError('OWNED_ACCOUNT_MISSING', 'Локальный файл указывает на отсутствующий учебный аккаунт. Автоматически заменять его не будем.');
  }
  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run', writes: false, email, existingUserId: existing?.id || null,
      businessName: profile.businessName, locations: locations.map(({ locationId, name, address, latitude, longitude, openingHours, deliveryWindows, deliveryRouteStreets, waterDependency }) => ({ locationId, name, address, latitude, longitude, openingHours, deliveryWindows, deliveryRouteStreets, waterDependency })),
      publishedSources, missingSources, scenarioDate: bundle.scenarioDate,
      scenarioExpired: Date.now() >= Date.parse('2026-11-16T23:00:00+03:00'),
      next: 'Для создания отдельного учебного аккаунта запустите --apply; открытие страницы само не вызывает Gemini.',
    }, null, 2));
  } else {
    if (process.env.RADAR_DEMO_MODE === 'true') throw new SetupError('DEMO_MODE', 'Для проверки настоящего Gemini нужен LIVE-путь; fixture не подставляется.');
    if (missingSources.length || publishedSources.some(source => !source.explicitlySynthetic)) {
      throw new SetupError('SOURCE_PREFLIGHT', 'Не все сохранённые учебные публикации подтверждены. Источники автоматически не создаются и не публикуются.');
    }
    await mkdir(new URL('.local/', root), { recursive: true });
    let user = existing;
    let privateAccess = credentials;
    if (!user) {
      privateAccess = privateAccess || { kind: marker, email, password: randomBytes(30).toString('base64url'), userId: null, createdAt: new Date().toISOString() };
      if (!credentials) await writeFile(credentialsPath, JSON.stringify(privateAccess, null, 2), { flag: 'wx', mode: 0o600 });
      const result = await register({ email, password: privateAccess.password, name: profile.name, businessName: profile.businessName, businessType: profile.businessType, city: profile.city });
      user = result.user;
      registrationToken = result.token;
      privateAccess = { ...privateAccess, userId: user.id };
      await writeFile(credentialsPath, JSON.stringify(privateAccess, null, 2), { mode: 0o600 });
    }
    let profileUpdated = false;
    if (user.email !== email) {
      user = await db.user.update({ where: { id: user.id }, data: { email } });
      privateAccess = { ...privateAccess, email };
      await writeFile(credentialsPath, JSON.stringify(privateAccess, null, 2), { mode: 0o600 });
    }
    if (!ownsFields(user, profile)) { await updateProfile(user.id, profile); profileUpdated = true; }
    const owned = await db.userLocation.findMany({ where: { userId: user.id } });
    let created = 0, updated = 0, unchanged = 0;
    for (const location of locations) {
      const previous = owned.find(item => item.locationId === location.locationId);
      if (previous && ownsFields(previous.profile, location)) { unchanged += 1; continue; }
      await savePersonalLocation(user.id, location, previous?.id);
      if (previous) updated += 1; else created += 1;
    }
    const count = await db.userLocation.count({ where: { userId: user.id } });
    console.log(JSON.stringify({ mode: 'applied', email, userId: user.id, profileUpdated, created, updated, unchanged, locations: count, credentialsFile: fileURLToPath(credentialsPath), publishedSources, analysisRequested: analyze }));
    if (analyze) {
      console.log('Обработка четырёх публикаций. Дождитесь завершения запросов Gemini.');
      const run = await analyzePendingNews(undefined, 4, undefined, { userId: user.id, messageIds: sources.map(source => source.id) });
      const state = await getProductState(await db.user.findUniqueOrThrow({ where: { id: user.id } }));
      console.log(JSON.stringify({ analysis: run, recommendations: state.recommendations.length, status: state.analysisHealth.status }));
      if (state.recommendations.length < 3) {
        console.error('Не все советы готовы. Проверьте сообщения приложения и доступность Gemini. Истёкшие события не создают активные советы.');
        process.exitCode = 1;
      }
    }
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof SetupError ? error.code : 'SHOWCASE_SETUP_FAILED', message: error instanceof SetupError ? error.message : 'Подготовка не завершена. Секреты и детали запроса не выводятся.' }));
  process.exitCode = 1;
} finally {
  if (registrationToken) await logout(registrationToken);
  await db.$disconnect();
}
