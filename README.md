# ate-env-demo

An [ate.dev](https://ate.dev/)-style demo page: a real shell on the left for
running the Antigravity CLI (`agy`), and the `atespace / …` cluster
visualization on the right, driven live by your Agent Substrate cluster.

```sh
npm install
npm start            # http://127.0.0.1:3000
```

- **Shell**: a login `$SHELL` in a PTY, streamed to xterm.js over a WebSocket.
  Click **▶ agy** or type `agy`.
- **Cluster**: the server polls `kubectl ate get actors -A -o json` and the
  `WorkerPool` CRs. To avoid kubectl-ate's per-call port-forward (2–10s), it
  keeps one `kubectl port-forward -n ate-system svc/api` open and passes `--endpoint`.
- **Fallback**: if the cluster is unreachable, the page runs a simulated cluster
  like ate.dev's. Force it with `/?demo`.

| env | default | |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | The shell runs as you, so only bind to localhost. |
| `ATESPACE` | all | Limit to one atespace. |
| `DEMO_CWD` | `$HOME` | Working directory for the shell. |
| `DEMO_SHELL` | `$SHELL` | Shell to spawn. |
| `POLL_MS` | `1000` | Delay between cluster polls. |
| `ATE_ENDPOINT` | | Use an existing ate-api endpoint instead of the built-in port-forward. |
| `ATE_PORT_FORWARD` | `1` | `0` lets kubectl-ate manage its own tunnels. |
| `ATE_API_SVC` / `ATE_PF_PORT` | `ate-system/svc/api:443` / `18443` | Port-forward target. |
