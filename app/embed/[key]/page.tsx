import EmbedApp from './embed-app';

// An iframe target must render at request time (params are runtime data):
// a blocking route is exactly what we want here.
export const instant = false;

export default async function EmbedPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  return (
    <main className="h-screen w-full bg-white">
      <EmbedApp botKey={key} />
    </main>
  );
}
