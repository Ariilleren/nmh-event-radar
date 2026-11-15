import { ProductApp } from '@/components/product-app';
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) { const query = await searchParams; return <ProductApp view="login" returnTo={query.next} />; }
