import { ProductApp } from '@/components/product-app';
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) { const query = await searchParams; return <ProductApp view="register" returnTo={query.next} reason={query.reason} />; }
