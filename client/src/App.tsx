import { useEffect, useState } from "react";

export default function App() {
  const [status, setStatus] = useState<string>("loading...");
  const [agents, setAgents] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    fetch("/api/v1/debug/ping-all")
      .then((r) => r.json())
      .then((body) => {
        setStatus(body.data?.status ?? "error");
        setAgents(body.data?.agents ?? null);
      })
      .catch((err) => {
        setStatus(`error: ${err.message}`);
      });
  }, []);

  return (
    <main style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>IncidentIQ</h1>
      <p>System status: <strong>{status}</strong></p>
      {agents && (
        <table>
          <thead>
            <tr><th>Agent</th><th>Response</th></tr>
          </thead>
          <tbody>
            {Object.entries(agents).map(([name, response]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{response}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
