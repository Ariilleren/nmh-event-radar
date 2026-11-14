import { RadarDashboard } from '@/components/radar-dashboard';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <RadarDashboard view="event" eventId={id} />; }
