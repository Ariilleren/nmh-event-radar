import type { Metadata } from 'next';
import './globals.css';
import '@fontsource/golos-text/cyrillic-400.css';
import '@fontsource/golos-text/cyrillic-500.css';
import '@fontsource/golos-text/cyrillic-600.css';
import '@fontsource/golos-text/cyrillic-700.css';
import '@fontsource/golos-text/latin-400.css';
import '@fontsource/golos-text/latin-600.css';
import '@/components/product-ui.css';
export const metadata: Metadata = { title: 'Рядом · Город для вашего бизнеса', description: 'Новости рядом с вашим бизнесом. Карта событий, личные точки и уведомления.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ru"><body>{children}</body></html>; }
