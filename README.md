# ate-env-demo

agy in the browser, with each tab's file and shell work running in its own
Agent Substrate actor, next to a live view of the cluster.

![agy running in the browser shell next to the live atespace view](docs/screenshot.png)

```sh
npm install
npm start            # http://127.0.0.1:3000
```

Needs `agy`, `kubectl`, `kubectl-ate`, `ate-env`, and a cluster running
[env](https://github.com/agent-substrate/env). Without a cluster, the page
shows a simulated one (force it with `/?demo`).

- Each tab runs agy with an `env` MCP server for an actor named after the tab's
  UUID, and tells agy to use it for all file and shell work.
- The actor is suspended after each tool call and wakes on the next one.
- The right panel shows actors and worker pods. Outlined boxes are actors of
  open tabs.
- The navbar picks the kubeconfig context.

| env | default | |
| --- | --- | --- |
| `KUBE_CONTEXT` | current-context | Cluster to start on. |
| `ATESPACE` | all | Limit the view to one atespace. |
| `AGY_MODEL` | `gemini-3.8-flash-medium` | Model passed to `agy --model`. |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | The shell runs as you, so only bind to localhost. |

See the top of `server.js` for the rest.
