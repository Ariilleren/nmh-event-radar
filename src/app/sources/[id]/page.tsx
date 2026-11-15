import { ProductApp } from '@/components/product-app';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductApp view="source" id={id} />;
}
