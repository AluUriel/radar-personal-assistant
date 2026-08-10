export const dynamic = "force-dynamic";

export default function NotAuthorized() {
  return (
    <main className="auth-message">
      <div className="brand-mark" aria-hidden="true"><span /></div>
      <p className="eyebrow">PRIVATE RADAR</p>
      <h1>This account does not have access</h1>
      <p>Radar contains private communications. Sign in with the configured owner account or return to the local application.</p>
      <a href="/signout-with-chatgpt?return_to=/">Switch accounts</a>
    </main>
  );
}
