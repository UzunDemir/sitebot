import AdminApp from './admin-app';

export default function AdminPage() {
  return (
    <main className="admin-shell min-h-screen px-3 py-6 sm:py-10">
      <div className="admin-rect mx-auto w-full max-w-6xl">
        <AdminApp />
      </div>
    </main>
  );
}
