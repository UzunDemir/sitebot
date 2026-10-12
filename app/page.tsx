import Chat from './chat';

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 px-3 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <Chat />
      </div>
    </main>
  );
}
