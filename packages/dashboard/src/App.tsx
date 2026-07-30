/**
 * The dashboard shell. T7 gives it Cognito auth and the editor; T1 only needs
 * it to exist, build to hashed assets, and prove the `/app/*` split in dev.
 */
export function App() {
  return (
    <main>
      <h1>All-Links</h1>
      <p>
        The dashboard lives here, at <code>/app/</code>. Sign-in and the editor arrive with T7.
      </p>
      <p className="note">
        Everything outside <code>/app/</code> is proxied to the local handler server, the same
        split the distribution makes at the edge.
      </p>
    </main>
  );
}
