import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Радар бизнеса · NMH', description: 'События вокруг ваших точек. Локальный кабинет операционного менеджера.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ru"><body>{children}</body></html>; }
