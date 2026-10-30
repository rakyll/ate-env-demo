# ate-env-demo

An [ate.dev](https://ate.dev/)-style demo page: a real shell on the left for
running the Antigravity CLI (`agy`), and the `atespace / …` cluster
visualization on the right, driven live by your Agent Substrate cluster.

![agy running in the browser shell next to the live atespace view](docs/screenshot.png)

```sh
npm install
npm start            # http://127.0.0.1:3000
```

- **Sessions**: each tab is a login `$SHELL` in its own PTY, streamed to
  xterm.js over a WebSocket. **+** or Alt+T opens a tab, Alt+W closes it, and
  Alt+1…9 switches between tabs.
- **One actor per session**: each tab gets a UUID session ID. Its shell exports
  `AGY_SESSION_ID`, `ATE_ACTOR` (same value), `ATE_ATESPACE`,
  `ATE_ACTOR_TEMPLATE`, `ATE_ENDPOINT`, `AGY_MODEL`, and `AGY_SESSION_PROMPT`.
  The tab then starts `agy --model "$AGY_MODEL" -i "$AGY_SESSION_PROMPT"`, which tells agy that it owns the actor
  named after the session and should manage it with `kubectl ate`. The
  visualization outlines actors owned by open tabs and labels them with the
  tab name.
- **Cluster**: the server polls `kubectl ate get actors -A -o json` and the
  `WorkerPool` CRs. To avoid kubectl-ate's per-call port-forward (2–10s), it
  keeps one `kubectl port-forward -n ate-system svc/api` open and passes `--endpoint`.
- **Fallback**: if the cluster is unreachable, the page runs a simulated cluster
  like ate.dev's. Force it with `/?demo`.

| env | default | |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | The shell runs as you, so only bind to localhost. |
| `ATESPACE` | all | Limit to one atespace. |
| `AGY_ACTOR_ATESPACE` | `$ATESPACE` or `ate-ant` | Atespace for session actors. |
| `AGY_ACTOR_TEMPLATE` | | Actor template for session actors. If unset, agy asks which one to use. |
| `AGY_MODEL` | `gemini-3.8-flash-medium` | Model passed to `agy --model` (see `agy models`). |
| `DEMO_CWD` | this repo | Working directory for the shell and agy. |
| `DEMO_SHELL` | `$SHELL` | Shell to spawn. |
| `POLL_MS` | `1000` | Delay between cluster polls. |
| `ATE_ENDPOINT` | | Use an existing ate-api endpoint instead of the built-in port-forward. |
| `ATE_PORT_FORWARD` | `1` | `0` lets kubectl-ate manage its own tunnels. |
| `ATE_API_SVC` / `ATE_PF_PORT` | `ate-system/svc/api:443` / `18443` | Port-forward target. |
