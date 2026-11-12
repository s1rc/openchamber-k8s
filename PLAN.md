# K8s extension: build plan

A Lens-style Kubernetes IDE inside OpenChamber, scoped to the open project's cluster and namespace when it can tell, with agent tools that respect a production lock.

This file is the contract for the build. Work the phases in order. Each phase ends with its "Done when" checks passing. If a spike in Phase 0 fails, stop and report before building on top of it.

## Read first

1. `/Users/example/.config/openchamber/run/instances/<n>/skills/openchamber-extensions/SKILL.md` (the instance number in the path changes when OpenChamber restarts: if missing, `ls /Users/example/.config/openchamber/run/instances/`).
2. `../shared-ui/USAGE.md`.
3. `node_modules/@openchamber/sdk/API.md` and `GUEST_SERVICES.md` after install, for any manifest key or host method.
4. `../linear` as the reference layout for a Preact extension with shared-ui (build script, `src/app`, `src/blocks`, `src/service`, styles concatenation).
5. `../wiz` for a service with `exec`, skills, instructions, mentions and blocks.

## Decisions (from the interview)

| Topic | Decision |
|---|---|
| Lens views | All of them: cluster overview, nodes, workloads, config, network, storage, namespaces, events, access control, custom resources, Helm, logs, pod shell, port forwarding, YAML view and edit, metrics, Flux and Argo CD |
| Writes | Full write. Production contexts are locked (read-only) until the user unlocks them |
| Project detection | Priority: 1. remembered pick for this project, 2. env files, 3. inferred from repo contents. No repo pin file, no repo-name matching |
| Placement | Rail panel, full page (same app, wide layout), `@` mentions, chat blocks, "Ask agent" on any resource, agent instructions and skill. No Work Status section |
| Pod shell | Inside OpenChamber only. Copy shell command (paste into OpenChamber's terminal) plus a one-command console in the panel. Never launch an external terminal app |
| Metrics | metrics-server for current usage, Prometheus for history when found |
| Updates | Live watch, pushed from the service |
| Clusters | Kubeconfig plus EKS discovery across AWS profiles. Expired SSO shows a Sign in button |
| Port forwards | Keep running after the panel closes, until stopped |
| Secrets | Masked, reveal on click in the UI. The agent never gets values (mentions, Ask agent, blocks, plugin tools all redact) |
| Agent access | OpenCode plugin tools that obey the lock. A write on a locked context needs a `K8sApprove` click |
| Blocks | `K8sApprove`, `K8sLogs`, `K8sEvents`, `K8sPickContext` |
| UI stack | Preact (`@openchamber-ext/shared-ui/preact`), the size of this UI needs components |
| Visibility | Private, local install only |

### Full page vs rail panel

`contributes.page: true` reuses `panel.entry`. The panel cannot open the page itself (the sidebar's Extension pages menu is the only opener, and `openSurface` does not open it). So: one app, two layouts chosen from `ctx.surface` and width. Rail (about 360px): stacked, one thing at a time. Page: Lens layout with left nav, table, right detail drawer, bottom dock.

## User's environment (checked on this machine)

- `/opt/homebrew/bin`: `kubectl` 1.37, `helm`, `aws`, `gcloud`, `k9s`. No `az`.
- Kubeconfig contexts (all EKS):
  - `initech-production-ap-southeast-2`, `initech-production-us-east-1`, `initech-staging-us-east-1` (account 987654321098, aws exec auth)
  - `northwind-production-eks` (123456789012), `northwind-staging-eks-us-east-1` (210987654321), both user `nw-oidc` (likely kubelogin / `kubectl oidc-login`; confirm in Phase 0)
- Terminal: OpenChamber's own terminal only. The SDK gives extensions no terminal access, so the extension never opens or drives a terminal.
- The service gets only `PATH`, `HOME`, temp and locale from the host. No `AWS_PROFILE` or `KUBECONFIG` from the user's shell. `PATH` from a Finder-launched app may lack `/opt/homebrew/bin`.

## Architecture

```
panel/page (Preact, sandboxed) ──serviceRequest──▶ service (Node, keepRunning)
        ▲                                             │
        └──────────── host.emit(topic, data) ─────────┤
                                                       ├─ kubectl proxy --unix-socket (one per active context)
                                                       │     └─ REST: list, get, watch, logs, metrics, Prometheus service proxy
                                                       ├─ kubectl exec / port-forward / cordon / drain (child processes)
                                                       ├─ helm (child process, JSON output)
                                                       └─ aws (EKS discovery, sso login)
blocks (Preact) ──serviceRequest──▶ service
OpenCode plugin (runs in OpenCode) ──files──▶ ~/.config/openchamber-k8s/state  ◀── service
```

### Why `kubectl proxy` over a unix socket

- One authenticated channel per context. kubectl runs the exec auth plugins (aws, oidc) and refreshes tokens, so the service never handles credentials.
- Plain HTTP gives everything the UI needs: `?watch=true` streams, `/log?follow=true`, `/apis/metrics.k8s.io`, and Prometheus through `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/...` (no port-forward needed for metrics).
- `--unix-socket=<state>/sock/<hash>.sock` in a `0700` folder, so no other local user or browser tab can reach it (a TCP `kubectl proxy` is open to any local process). Node `http.request({ socketPath })`.
- Start on first use of a context; stop after 10 minutes unused. Restart on exit. Auth failure output from the proxy maps to the error codes below.

### Service lifetime

`service.keepRunning: true`, because port forwards must outlive the panel. Stay quiet when nothing is open: no proxies, no watches, no timers except forwards and lease expiry.

### Live watch

- Panel calls `POST /watch { context, namespace, kind }` and gets `{ watchId, items, resourceVersion }` (snapshot first, the skill says `emit` never replays).
- Service holds one watch stream per (context, namespace, kind), shared by every frame that asked.
- Pushes deltas as `host.emit('watch', { watchId, events: [{ type, object }] })`, batched every 250 ms, split to stay under 64 000 characters and 30 emits per second. Strip `managedFields` before sending.
- Lease: the panel renews `POST /watch/lease { watchIds }` every 30 s while visible (`document.visibilityState`). A watch with no lease for 60 s closes. Handle `410 Gone` by relisting.
- On service restart the frame gets `UNKNOWN_WATCH` on lease and resubscribes.

### Shared state on disk

The plugin runs inside OpenCode and cannot call the service, so the lock and approvals live in files both read. Folder `~/.config/openchamber-k8s/` (mode `0700`, files `0600`), outside the package so writes never reload the extension:

| File | Contents |
|---|---|
| `projects.json` | `{ [projectDir]: { context, namespace, source, pickedAt } }` remembered picks |
| `locks.json` | `{ protected: { [context]: true\|false }, unlocked: { [context]: expiresAtIso } }` |
| `approvals.json` | `{ [hash]: { expiresAt, action, used: false } }`, single use, 10 minute expiry |
| `forwards.json` | active port forwards, to restore after a service restart |
| `sock/` | proxy sockets |

Write with write-to-temp then rename. Keep `OPENCHAMBER_SERVICE_DATA_DIR` for service-only caches (EKS discovery results, resource index).

The lock is a guardrail, not a security boundary: an agent with shell access can run `kubectl` directly or edit these files. Say so in the skill, and tell agents to use the plugin tools.

### Production detection

A context is protected when its name or cluster ARN matches `/prod/i`, unless the user overrides it per context (a switch in the context picker, saved in `locks.json`). Unlock lasts 30 minutes per context. The panel shows a warning banner with a countdown and "Lock now" while unlocked.

### Errors (never a 500)

Every route answers `{ ok: false, code, error, action? }` on failure. Codes:

| Code | When | UI |
|---|---|---|
| `NO_KUBECTL` | binary not found | Banner: install kubectl, shows the PATH searched |
| `AUTH_EXPIRED` | aws SSO or OIDC token expired | Banner with Sign in button: `POST /auth/login` runs `aws sso login --profile <p>` (opens the browser) or, for OIDC, runs `kubectl --context X get ns` from the service so kubelogin opens the browser. No terminal window |
| `FORBIDDEN` | RBAC 403 | Inline note on that view, keep the rest working |
| `UNREACHABLE` | network, VPN, private endpoint | Banner: cluster not reachable, check VPN |
| `LOCKED` | write on a protected context | Unlock prompt |
| `NOT_FOUND`, `CONFLICT` | k8s 404, 409 | Toast with the message |
| `INVALID`, `BAD_REQUEST` | k8s 400 or 422, or a bad argument | Toast with the message |
| `NO_CONTEXT` | the cluster name is not in the kubeconfig | Inline note, back to the picker |
| `UNKNOWN_WATCH` | lease for a watch the service no longer has | Frame opens the watch again |
| `K8S_ERROR`, `INTERNAL` | anything unclassified | Toast with a short message |

Binary lookup: `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/bin`. Pass the extended `PATH` to every child, so kubectl finds `aws` and `kubectl-oidc_login`.

## Project scope resolver

Input: project directory (from `ctx` in the frame, `directory` in mention searches, the plugin tool context). Output: `{ context, namespace, source, confidence, reasons[] }` or `null`.

1. **Remembered pick**: `projects.json[dir]`. Saved whenever the user picks a context or namespace in that project. Source label "Your pick".
2. **Env files** in the project root: `.envrc`, `.env`, `.env.local`, `.env.development`. Parse `export KEY=value` and `KEY=value` only, never execute.
   - `KUBECONFIG`: use that file for this project (pass `--kubeconfig`).
   - `KUBECONTEXT`, `KUBE_CONTEXT`, `K8S_CONTEXT`: context by name.
   - `AWS_PROFILE`: read `~/.aws/config` for `sso_account_id` or the role ARN account, and `region`; pick contexts whose cluster ARN has that account, prefer that region. Several matches: return all as candidates, preselect none, let the user pick, then remember the pick.
   - `NAMESPACE`, `KUBE_NAMESPACE`, `K8S_NAMESPACE`.
   Source label "From .envrc" (the actual file name).
3. **Repo contents**, bounded scan (max depth 4, max 2 000 files, skip `node_modules`, `.git`, `vendor`, `dist`):
   - Argo CD `Application`/`ApplicationSet`: `spec.destination.server` or `.name`, `spec.destination.namespace`.
   - Flux `Kustomization`/`HelmRelease`: `spec.targetNamespace`, `metadata.namespace`.
   - Kustomize `kustomization.yaml`: `namespace`.
   - Helm `values*.yaml` per env folder, `Chart.yaml` name as a hint for release name.
   - Plain manifests: most common `metadata.namespace`.
   - Terraform: `aws_eks_cluster` `name`, `module "eks"` `cluster_name`, `data "aws_eks_cluster"` `name`; match against cluster ARN suffix.
   - Skaffold `deploy.kubeContext`, Tilt `allow_k8s_contexts`.
   Score candidates, return the best with `reasons` ("namespace `contracts` from k8s/overlays/staging/kustomization.yaml").
4. Nothing found: no scope, the panel shows all contexts with the kubeconfig current one selected and a hint "Pick a cluster to remember it for this project".

Cache results per directory for 5 minutes (mention search has a 2 s budget). Show the source as a chip next to the context picker, with the reasons in a tooltip.

## UI

Order of choice for every piece: SDK kit, then shared-ui, then local code with prefix `k8s-` and only `--oc-*` colors. Never rebuild a kit control.

| Piece | From |
|---|---|
| Buttons, selects (context, namespace, section), search, tabs, menus (row actions), switches (protected context), badges, banners (auth, lock, unreachable), empty states, spinners, progress (capacity), text fields (YAML editor, console input, values) | Kit |
| Stat cards (overview counts), cards, sections, key/value grids (resource overview), chips (labels, annotations, source), dots (status), `api` call, `toast` | shared-ui |
| Resource table (sortable, column registry, virtualized past 300 rows), detail drawer, bottom dock, log viewer (ANSI-free, search, wrap toggle), sparkline and area charts (SVG), YAML diff view, pod container dots | Local |

### Layout

**Header** (both layouts): context select (searchable, grouped by AWS account, shows protected badge), namespace select (All namespaces + list), scope source chip, lock badge with Unlock/Lock action, refresh state dot (live, reconnecting, offline).

**Page layout**: left nav (Lens order) | resource table | detail drawer (right, resizable). Bottom dock with tabs for open logs, consoles and the port forward list.

**Rail layout**: header, section select, table as a compact list (name, status dot, one key column), tap opens detail full width with a back button. Logs and console open as a detail tab.

### Navigation and columns (Lens parity)

| Section | Kinds | Key columns |
|---|---|---|
| Cluster | Overview | CPU, memory, pods capacity vs requests vs usage; node count; warning events list |
| Nodes | Node | Name, CPU, Memory, Disk, Taints, Roles, Version, Age, Conditions |
| Workloads | Overview, Pod, Deployment, DaemonSet, StatefulSet, ReplicaSet, Job, CronJob | Pod: Name, Namespace, Containers (dots), Restarts, Controlled by, Node, QoS, Age, Status. Deployment: Name, Namespace, Pods (ready/desired), Replicas, Age, Conditions. CronJob: Schedule, Suspend, Active, Last schedule |
| Config | ConfigMap, Secret, ResourceQuota, LimitRange, HorizontalPodAutoscaler, PodDisruptionBudget, PriorityClass, RuntimeClass, Lease, MutatingWebhookConfiguration, ValidatingWebhookConfiguration | Secret: Name, Namespace, Labels, Keys, Type, Age. HPA: Metrics, Min, Max, Replicas |
| Network | Service, Endpoints, EndpointSlice, Ingress, IngressClass, NetworkPolicy | Service: Type, Cluster IP, Ports, External IP, Selector, Status |
| Storage | PersistentVolumeClaim, PersistentVolume, StorageClass | PVC: Storage class, Size, Pods, Status |
| Namespaces | Namespace | Name, Labels, Age, Status |
| Events | Event | Type, Message, Namespace, Involved object, Source, Count, Age, Last seen |
| Helm | Releases, Charts | Release: Name, Namespace, Chart, Revision, Version, App version, Status, Updated |
| Access control | ServiceAccount, ClusterRole, Role, ClusterRoleBinding, RoleBinding | Bindings: Subjects, Role |
| Custom resources | Definitions, then one entry per CRD grouped by API group | `additionalPrinterColumns` from the CRD |
| GitOps | Flux (Kustomization, HelmRelease, GitRepository, HelmRepository, OCIRepository), Argo CD (Application, ApplicationSet, AppProject) | Ready/Synced/Health, revision, last reconcile, message. Shown only when the CRDs exist |
| Port forwarding | Active forwards | Resource, Ports, Local URL, Status |

Column definitions live in one registry (`src/shared/kinds.ts`): kind, API path, namespaced, columns with value getters and sort keys, status function, actions. Unknown kinds fall back to Name, Namespace, Age.

### Detail drawer

Tabs: Overview (kv grid: metadata, labels and annotations as chips, owner and controlled links, conditions table, kind-specific blocks such as containers with image, ports, env (secret refs shown as references), mounts, probes, resources), YAML, Events, Logs (pods and workloads), Metrics (pods, nodes, workloads), Pods (for controllers, services), History (Deployments, Helm).

Action menu per kind:

| Kind | Actions |
|---|---|
| Pod | Logs, Copy shell command, Console, Port forward, Edit, Delete, Evict, Ask agent |
| Deployment, StatefulSet, DaemonSet | Logs (all pods), Scale, Restart, Rollback (pick revision), Pause/Resume (Deployment), Edit, Delete, Ask agent |
| CronJob | Trigger now, Suspend/Resume, Edit, Delete, Ask agent |
| Job | Logs, Delete, Ask agent |
| Node | Cordon, Uncordon, Drain (confirm, shows pods to evict), Copy node shell command (`kubectl debug node/<n> -it --image=busybox`), Ask agent |
| Service | Port forward, Edit, Delete |
| Secret | Reveal values (per key), Edit, Delete |
| Helm release | Values, Manifest, History, Rollback, Upgrade with edited values, Uninstall |
| Flux | Reconcile (annotate `reconcile.fluxcd.io/requestedAt`), Suspend/Resume |
| Argo CD Application | Refresh, Sync (patch `operation`), Ask agent |
| Any | Copy name, Copy YAML, Edit, Delete |

Every write on a protected locked context is refused with `LOCKED`. Delete, drain, rollback, uninstall and any edit show a confirm step. Edit runs a server-side dry run first (`?dryRun=All`) and shows the diff before Save.

### Logs

Follow via `GET /api/v1/namespaces/<ns>/pods/<pod>/log?follow=true&timestamps=true&tailLines=500&container=<c>`, pushed as `emit('logs', { streamId, lines })` with the same batching and lease as watches. Container select, Previous (crashed) toggle, timestamps toggle, wrap toggle, search with highlight, Download (copy to clipboard), "Ask agent about these logs". Workload logs merge every pod with a pod prefix column. Keep 5 000 lines in the frame.

### Shell and console

- **Shell**: the extension never opens a terminal app. "Copy shell command" builds `kubectl --context <c> -n <ns> exec -it <pod> -c <container> -- sh -c 'command -v bash >/dev/null && exec bash || exec sh'` (every value shell-escaped), copies it with `host.writeClipboard` (not `navigator.clipboard`, which the sandbox blocks), and toasts "Copied. Paste it in OpenChamber's terminal." The drawer also shows it as a selectable mono line with a copy button.
- **Console** (panel): one command at a time, `kubectl exec <pod> -c <c> -- sh -c '<input>'`, no TTY, 30 s timeout, output capped at 1 MB, history up/down. Shows a note that interactive programs need Shell.

### Port forwarding

`kubectl port-forward` per forward (`pod/<p>` or `svc/<s>`), local port chosen by the user or free port. Listed in the Port forwarding section and the dock with Open (link to `http://localhost:<port>`), Copy, Stop. Restore from `forwards.json` on service start. Restart a dropped forward up to 3 times, then mark it failed.

### Metrics

- metrics-server: `/apis/metrics.k8s.io/v1beta1/nodes` and `.../pods`. If missing, show "Install metrics-server for usage" in the overview, not an error.
- Prometheus detection per context: Services labelled `app.kubernetes.io/name` in `prometheus`, `kube-prometheus-stack-prometheus`, or named `prometheus-*`, `prometheus-operated`. User override in the context menu ("Prometheus service"). Queries through the service proxy: CPU, memory, network, filesystem per pod, node and workload, last 1 h at 60 s step (Lens's default queries are the model). Charts are local SVG using `--oc-primary`, `--oc-info`, `--oc-warning`, `--oc-muted`.
  - **Changed in Phase 4:** the service proxy to a pod port does not work on every cluster (staging's API server cannot reach port 9090). When the proxy does not answer, the service reaches Prometheus through a hidden `kubectl port-forward` of its own (see "Phase 4 results").

### EKS discovery and sign-in

- Read profiles from `~/.aws/config`. For each profile with SSO or credentials, run `aws eks list-clusters --region <r>` for the profile's region and any region already in the kubeconfig. Cache 1 h in the data dir, refresh on demand ("Discover EKS clusters" in the context select).
- A discovered cluster missing from kubeconfig shows "Add" which runs `aws eks update-kubeconfig --name <n> --region <r> --profile <p> --alias <account-alias-or-name>-<region>`. This writes to `~/.kube/config`: confirm first, show the exact command.
- Expired SSO: detect `Token has expired`, `SSO session ... expired`, `UnauthorizedSSOTokenError` in proxy or aws output. Sign in runs `aws sso login --profile <p>` (opens the browser), then retries.

### Ask agent

Menu item on every resource, log view and event list. Uses `host.prompt` with `send: true` (capability `prompt`) into the current session; with no session, `host.startSession`. Text: context, namespace, kind/name, a trimmed redacted YAML (no `managedFields`, no `status` noise beyond conditions), last 20 events, and for pods the last 100 lines of each container's logs, plus the question "Summarize this resource and find the cause of any problem." Cap at 40 000 characters.

### Redaction (one function, used everywhere the agent can see data)

- Secret: replace each `data` and `stringData` value with `<redacted, N bytes>`.
- Any object: drop `metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]` for Secrets (it holds the values).
- Helm: release values and manifests can hold secrets. Redact keys matching `/(password|secret|token|key|credential)/i` and every `kind: Secret` document in a manifest.
- Unit tests for each rule.

## Agent surfaces

### Instructions (`instructions: true`)

Per project, once its scope is resolved: `setInstructions(dir, text)` with about 6 lines: the context and namespace, whether it is protected and locked, "Use the k8s_* tools, not raw kubectl. Writes on a locked context need the user's K8sApprove click." Global (`null`) text: one line pointing to the skill. Update when the scope or lock changes.

### Skill (`skills/k8s/SKILL.md`)

Name the work in the description: "Inspect, debug or change Kubernetes resources in the user's clusters". Covers: the tools and when to use each, always pass context and namespace, the approval flow, the blocks and their arguments, redaction (never ask for secret values), and that the lock is a guardrail.

### OpenCode plugin (`plugin/index.js`, bundled from `src/plugin/index.ts`)

Default export `{ id: 'k8s-tools', setup }`, imports nothing at the top (spike: dynamic `import('node:child_process')` or `Bun.spawn` inside `execute`). Tools, all with `options: { codemode: false }` and JSON Schema input:

| Tool | Input | Notes |
|---|---|---|
| `k8s_contexts` | none | Contexts, protected and lock state, project scope if any |
| `k8s_get` | context?, namespace?, kind, name?, selector?, output (`table`/`yaml`) | Redacted |
| `k8s_describe` | context?, namespace?, kind, name | Redacted, events included |
| `k8s_logs` | context?, namespace?, pod, container?, tail (max 500), previous? | |
| `k8s_events` | context?, namespace?, kind?, name? | |
| `k8s_apply` | context?, namespace?, manifest, dryRun? | Server-side apply. Dry run always allowed |
| `k8s_scale` | context?, namespace?, kind, name, replicas | |
| `k8s_restart` | context?, namespace?, kind, name | `rollout restart` |
| `k8s_delete` | context?, namespace?, kind, name | |

Missing context/namespace uses the project scope (spike: find the directory in the tool's execute context; fallback `process.cwd()`).

Write flow on a protected, locked context:

1. Tool computes `hash = sha256(context|namespace|verb|kind|name|sha256(payload))`.
2. No matching unused approval in `approvals.json`: answer `{ content }` "Locked. Ask the user with K8sApprove(\"<context>\", \"<namespace>\", \"<verb>\", \"<kind>/<name>\", \"<summary>\", \"<hash>\"), then call this tool again with the same arguments."
3. User clicks Approve in the block: block calls `POST /approve { hash, ... }`, service checks the hash matches the shown arguments, writes the approval (10 min, single use), then `answerBlock('approved')`. Reject answers `rejected`.
4. Agent calls the tool again, plugin finds and marks the approval used, runs the write.

Unprotected or unlocked contexts write directly. Every write is appended to `~/.config/openchamber-k8s/audit.log` (time, project, context, verb, target, source: panel or agent).

`contributes.tools`: `{ "match": "k8s_*", "name": "Kubernetes", "icon": "icon.svg", "title": "{input.kind} {input.name}", "output": "auto" }`.

### Mentions (`mentions: { label: "Kubernetes" }`)

Search: pods, deployments, statefulsets, services, cronjobs in the project scope (else current context, all namespaces), from an in-memory index refreshed in the background every 60 s while used and on watch events. Answer in under 2 s from memory, empty on a cold start while it fills. Title `<kind>/<name>`, subtitle `<namespace> · <context> · <status>`. Resolve: the same text as Ask agent, redacted.

### Blocks (one `blocks/index.html`, routed by name)

| Block | Args | answers | Draws |
|---|---|---|---|
| `K8sApprove` | context, namespace, verb, target, summary, hash | true | Protected badge, exact change, diff for apply (fetched from service by hash), Approve / Reject. Never acts until clicked |
| `K8sLogs` | context, namespace, pod, container, lines | false | Last N lines (max 200), refresh button, "Open in panel" hint |
| `K8sEvents` | context, namespace, kind, name | false | Event rows with type dot, reason, message, count, age |
| `K8sPickContext` | question, filter | true | Contexts (filtered by substring) with account and protected badge, namespace select, Use. Answers `context/namespace` and saves the pick for the project |

Descriptions must stay under 120 characters and narrow enough that `K8sPickContext` takes only cluster questions.

## Manifest draft

```json
{
  "name": "k8s",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=2.7.0" },
    "id": "k8s",
    "name": "Kubernetes",
    "icon": "icon.svg",
    "contributes": {
      "panel": { "entry": "panel/index.html" },
      "page": true,
      "capabilities": ["prompt", "sessions"],
      "service": {
        "entry": "service/main.js",
        "runtime": "host",
        "keepRunning": true,
        "permissions": { "exec": ["kubectl", "helm", "aws"] }
      },
      "instructions": true,
      "skills": "skills",
      "opencodePlugin": "plugin",
      "mentions": { "label": "Kubernetes" },
      "blocks": [
        { "name": "K8sApprove", "description": "Asks the user to approve a write on a locked cluster. Args from the k8s tool's Locked reply", "args": ["context", "namespace", "verb", "target", "summary", "hash"], "entry": "blocks/index.html", "height": 220, "answers": true },
        { "name": "K8sLogs", "description": "Shows the last lines of a pod's logs. lines: count, max 200", "args": ["context", "namespace", "pod", "container", "lines"], "entry": "blocks/index.html", "height": 240 },
        { "name": "K8sEvents", "description": "Shows recent Kubernetes events for a resource or a namespace", "args": ["context", "namespace", "kind", "name"], "entry": "blocks/index.html", "height": 200 },
        { "name": "K8sPickContext", "description": "Asks which Kubernetes cluster and namespace to use. filter: part of a context name, or empty", "args": ["question", "filter"], "entry": "blocks/index.html", "height": 220, "answers": true }
      ],
      "tools": [
        { "match": "k8s_*", "name": "Kubernetes", "icon": "icon.svg", "title": "{input.kind} {input.name}", "output": "auto" }
      ]
    }
  },
  "dependencies": { "@openchamber/sdk": "2.7.0", "@openchamber-ext/shared-ui": "../shared-ui", "preact": "^11.2.0", "yaml": "^2" }
}
```

Check every key against `API.md` before relying on it. Ship `icon.svg` (Kubernetes wheel, single path, `currentColor`).

## File layout

```
k8s/
  package.json  tsconfig.json  icon.svg  PLAN.md  README.md  .gitignore (node_modules)
  scripts/build.sh
  src/
    app/        main.tsx, App.tsx, layout/, views/, detail/, dock/, table/, charts/
    blocks/     main.tsx (routes by block name)
    service/    main.ts, routes.ts, kubeconfig.ts, proxy.ts, k8s.ts (REST client), watch.ts, logs.ts,
                exec.ts, forwards.ts, helm.ts, metrics.ts, eks.ts, scope.ts, state.ts, mentions.ts,
                instructions.ts, errors.ts, bins.ts
    plugin/     index.ts
    shared/     kinds.ts, redact.ts, approval.ts (hash), types.ts, local.css
  panel/  index.html, main.js, styles.css (built)
  blocks/ index.html, main.js, styles.css (built)
  service/main.js  plugin/index.js (built)
  skills/k8s/SKILL.md
  test/   scope.test.ts, redact.test.ts, approval.test.ts, kinds.test.ts, fixtures/
```

`scripts/build.sh` follows `../linear/scripts/build.sh`: `bun install --silent`, bundle `src/app/main.tsx` to `panel/main.js`, `src/blocks/main.tsx` to `blocks/main.js`, `--node src/service/main.ts` to `service/main.js`, `--node src/plugin/index.ts` to `plugin/index.js`, then `cat` shared-ui styles plus `src/shared/local.css` into each frame's `styles.css`.

## Phases

Estimates are for the building agent, assuming spikes pass.

### Phase 0: scaffold and spikes (about 45 min) - DONE

1. `bun init -y`, `bun add @openchamber/sdk@2.7.0`, `bun add ../shared-ui`, `bun add preact`. Check the `package.json` diff bun rewrote.
2. Manifest from the draft, build script, `tsconfig` (`jsx: react-jsx`, `jsxImportSource: preact`), empty panel, blocks, service with `/health`, plugin with `k8s_contexts`.
3. Spikes, each a few lines, results written into this file under "Spike results":
   - a. Service `PATH` under the desktop app: does it include `/opt/homebrew/bin`? Does `kubectl --context initech-staging-us-east-1 get ns` work from the service with the extended PATH?
   - b. `kubectl proxy --unix-socket` with an EKS context; a `GET /api/v1/namespaces` over the socket from Node.
   - c. What the `nw-oidc` user runs (`kubectl config view --minify --context northwind-staging-eks-us-east-1 -o json`, read the exec block only, never print tokens).
   - d. Plugin: can `execute` spawn a process (dynamic `node:child_process` import or `Bun.spawn`)? What does its second argument hold (session id, directory)?
   - e. Dropped: no external terminal. Never launch Ghostty, Terminal.app or `osascript`.
   - f. `host.emit` from a `keepRunning` service reaches the panel and the page.

Done when: `bun run build` and `bunx openchamber-guest-check` pass, the extension installs, the panel says hello, all spikes have a recorded answer.

### Phase 1: service core (about 2 h) - DONE

Binary lookup, kubeconfig read (`kubectl config view -o json`, no secrets kept), contexts route, proxy manager, REST client with error mapping, state files, lock logic, scope resolver, routes: `GET /contexts`, `GET /scope?dir=`, `POST /scope` (remember pick), `POST /lock`, `POST /unlock`, `GET /list`, `GET /get`, `POST /watch`, `POST /watch/lease`, `POST /apply` (with `dryRun`), `POST /delete`, `POST /scale`, `POST /restart`.

Done when: curl against each route works on `initech-staging-us-east-1`, a write on a production context answers `LOCKED`, `scope.test.ts` and `approval.test.ts` pass.

**Phase 1 results** (built and checked on `initech-staging-us-east-1`):

- Service files: `bins`, `exec`, `errors`, `state`, `kubeconfig`, `proxy`, `k8s` (REST client, kind discovery), `watch`, `scope`, `routes`, `main`. Shared: `types`, `kinds` (paths only for now), `redact`, `locks`, `approval`.
- Routes: `GET /health`, `GET /contexts`, `GET /scope`, `POST /scope`, `POST /lock`, `POST /unlock`, `POST /protect` (the per-context override), `GET /list`, `GET /get`, `POST /watch`, `POST /watch/lease`, `POST /apply`, `POST /delete`, `POST /scale`, `POST /restart`. Every failure is HTTP 200 with `{ ok: false, code, error, action? }`; only an unknown route is 404.
- Checked live: contexts with protected and locked flags; scope from a `.envrc`; list and get (core, grouped, and kinds found through discovery); Secret values hidden in list, get and apply, shown only with `reveal=1`; a watch on Leases pushed `live` and batched `MODIFIED` events, lease renewal worked, `UNKNOWN_WATCH` for an unknown id, and a watch with no lease closed after 60 s; scale, restart, delete and apply as server-side dry runs on staging (nothing was changed); real writes on every production context answered `LOCKED` before any connection was made (no proxy was started for production); unlock and lock changed the state and the 30-minute expiry is unit-tested.
- Not exercised: a real (non-dry-run) write on staging, an expired SSO or OIDC token (it could open a browser), and any request to the `northwind-*` clusters.
- Tests: `bun test` runs 104 tests in 9 files, including `scope.test.ts` and `approval.test.ts`.

Decisions taken while building:

- Approval hash: fields are escaped (`\` and `|`) before joining. The plan's plain `|` join let `a|b` + `c` collide with `a` + `b|c`; a test caught it. The plugin in Phase 7 must use `approvalHash` from `src/shared/approval.ts`, not its own copy.
- A `KUBECONFIG` named in a project's env file is used only when the file is outside the repo. A kubeconfig can run programs through its exec auth block, so a cloned repo must not be able to point the service at its own file.
- Routes take `dir` (the project folder), never a kubeconfig path, so a block or frame cannot choose one.
- Watches keep the current objects in memory per (cluster, namespace, kind), so a second frame gets its snapshot without a new list. Secret watches store and push only the redacted object.
- A watch that fails with `AUTH_EXPIRED`, `FORBIDDEN`, `NOT_FOUND` or `NO_KUBECTL` stops retrying and reports `{ watchId, state: 'error', code }`, so an expired OIDC login cannot keep opening browser tabs. Other failures retry with a backoff up to 30 s.
- New dependency: `yaml` (service bundle only), for the scope scan and manifest parsing.
- The `k8s_spike_plugin` tool is still in the plugin. It stays until Phase 7 so the in-app check (does OpenCode call `setup` once per project, and is `ctx.location.directory` right) can still be run there.
- Left for later phases: `POST /approve` and the agent-side lock check (Phase 7), the per-kind columns and actions in `kinds.ts` (Phase 2), log streams (Phase 3), Sign in routes (Phase 6).

### Phase 2: panel shell and resource browsing (about 3 h) - DONE

Preact app, both layouts, header pickers, nav, kind registry for every kind in the table above, resource table with live watch, detail drawer with Overview, YAML (read), Events. Empty, loading and every error code drawn. Secrets masked.

Done when: every section lists on the staging cluster at both widths, light and dark, and a pod deleted with kubectl disappears from the table without a refresh.

**Phase 2 results** (built and checked on `initech-staging-us-east-1`, reads only):

- Files: `src/app/` has `App`, `Header`, `Nav`, `ResourceView`, `Table`, `errors`, `kit` (the SDK kit as Preact components), `host`, `watches` (event router and the lease timer), `useWatch`, `apply-events` (pure, tested) and `detail/` (`Drawer`, `Overview`, `Yaml`, `EventsTab`). `src/shared/kinds.ts` now holds columns, status, sorting, Overview details and the navigation for every kind; `src/shared/format.ts` holds age, quantity and byte text. `src/shared/local.css` carries the `k8s-` styles (theme colors only).
- Layouts: page layout when `ctx.surface` is `page` and the frame is at least 720px wide (left nav, table, resizable drawer on the right); everything else is the rail layout (header, section select, search, kit list, a tap opens the detail full width with Back, Escape also closes). The bottom dock is not drawn yet (Phase 3).
- Header: context select (searchable, sorted by AWS account, hint shows account, region and "protected"), namespace select (All namespaces plus a live Namespace watch), scope chip with the reasons as tooltip, lock badge (Locked, or Unlocked until HH:MM, only on protected contexts), live state dot (Connecting, Live, Reconnecting, Offline). Picking a context or namespace saves it with `POST /scope` when the frame has a project. No scope shows "Pick a cluster to remember it for this project"; several candidates preselect nothing and say so.
- Table: sortable columns from the registry (click a header; age sorts youngest first), search box, keyboard up and down, rows past 300 are windowed, horizontal scroll instead of squashing, Namespace column only for "All namespaces". Rail list is the kit list (status badge, one key column), capped at 300 rows with a note.
- Live: `POST /watch` gives the snapshot, `watch` events are applied by namespace and name (a relist keeps rows until the new ones arrive, so the table never flashes empty), events that came before the watch reply are replayed from a small buffer, objects too large to push are fetched with `GET /get`. The lease is renewed every 30 s while the panel is visible and stops when hidden; `UNKNOWN_WATCH` opens the watch again. This is the only timer in the panel.
- Drawer: Overview (common fields, status, per-kind rows from the registry, labels and annotations as chips, containers with image, ports, resources, probes, env with secret references shown as references, mounts, a conditions table; Secrets list their keys with "Values are hidden."), YAML (read only, drawn from the live object so it updates with the watch), Events (`GET /list` with a field selector on load and on Refresh, never on a timer).
- Errors: every code in the Errors table plus `failed` (the shared helper's code when a call itself fails) has a drawing: banners for `NO_KUBECTL`, `AUTH_EXPIRED`, `UNREACHABLE`, `LOCKED`, `CONFLICT`, `INVALID`, `BAD_REQUEST`, `K8S_ERROR`, `INTERNAL`, `UNKNOWN_WATCH`; a quiet note inside the view for `FORBIDDEN`, `NOT_FOUND`, `NO_CONTEXT`. Load failures are drawn in place; a toast only follows a click (a failed Refresh in the Events tab). Empty and loading states for every view, "No matches" with Clear search, "Choose a cluster", "No clusters found", and a "This resource was deleted" banner in the drawer.
- Secrets: the panel never sends `reveal`; list, watch and get replies are masked by the service and the panel shows only the key names and sizes. A test checks the registry never derives text from a value.

Checked live on staging:

- Every kind in the navigation lists with real data at page width (1100px) and rail width (360px), light and dark (a scripted sweep drew all 36 kinds in all four combinations: rows or the empty state each time, no banner, no page error, no horizontal overflow in the rail). Kinds with nothing on staging (StatefulSet, CronJob, ResourceQuota, LimitRange, RuntimeClass, NetworkPolicy, PVC, PV) showed the empty state.
- Live: with a Lease open in the drawer, `renewTime` and `resourceVersion` changed 9 s later with no refresh. The Event count moved (897, 901, 861, 863, 865) and the Pod count moved (105, 104, 102) over 60 s while the page stayed open, so ADDED and DELETED both arrive. Nothing was deleted or written to do this.
- The lock badge was checked for Locked and Unlocked (staging was marked protected in a throwaway state folder, then put back; the real `~/.config/openchamber-k8s` was never touched, and no `northwind-*` or production context was opened).
- Tests: `bun test` runs 175 tests in 11 files (new: `format`, `apply-events`, and the registry: every kind in the navigation has a well formed view that survives an empty object, pod status cases, container dots, sorting, search text, Secret masking).

Decisions and changes from the plan:

- Service change: `POST /unlock`, `POST /lock` and `POST /protect` now `publish('lock', { context, protected, locked, unlockedUntil })` through the same rate-limited queue as watch events (`publish` is exported from `watch.ts`), so the badge changes in the rail and the page together. No route changed behavior otherwise. The plan listed lock events for the panel, but Phase 1 never sent them.
- The lock badge has no Unlock or Lock button yet. Nothing writes in Phase 2, so the unlock flow, the banner with the countdown and Lock now stay in Phase 3.
- `AUTH_EXPIRED` shows the exact command to run in OpenChamber's terminal and a Try again button. The Sign in button waits for `POST /auth/login` in Phase 6.
- The context select cannot group, so it sorts by account and shows account, region and "protected" as the hint.
- Node CPU, Memory and Disk show allocatable (the header tooltip says so); usage arrives with metrics in Phase 4. PVC "Pods" is left out (it needs a pod lookup).
- Custom resources lists the Definitions only; the per-CRD entries, Helm, GitOps, Port forwarding and the two Overview pages are Phases 4 and 5. Cluster and Workloads Overview are not in the navigation yet, so the default section is Pods.
- Ages are computed when a row renders, so they refresh on every watch event but not on a timer (no timer by rule).
- Sort order, search, the selected row, the drawer tab and the drawer width live in memory and reset when the kind, namespace or cluster changes.
- The YAML tab uses the `yaml` package in the panel bundle (panel `main.js` is about 185 KB).
- The shared-ui harness cannot push service events and has no way to fail a call, so for the live and error checks I used a scratch harness outside the repo (the same `harness.html` plus an event relay and a failure switch, in the temp folder). Nothing in `../shared-ui` was edited. Screenshots of every state live in the temp folder and are not committed.
- Not done on purpose: deleting a pod with kubectl. The plan's Done-when line names it, but the rules for this phase forbid writes, so the same path (DELETED events reaching the table) was confirmed on pods and events that the cluster removed by itself.
- Left for Phase 3: the actions menu, confirm steps, the bottom dock, the unlock flow.

### Phase 3: actions, logs, shell, forwards (about 3 h) - DONE

Action menus, confirm steps, edit with dry-run diff, scale, restart, rollback, cordon, drain, cron trigger, Flux/Argo actions, logs dock, console, copy shell command, port forwards with restore, lock banner and unlock flow, audit log.

Done when: each action works on staging, each is refused on a locked production context, a port forward survives closing the panel and a service restart.

**Phase 3 results** (built and checked on `initech-staging-us-east-1` with a throwaway `K8S_STATE_DIR`):

- Service additions (all new routes answer `{ ok: false, code, error }` on failure, writes call `guard` first and append to `audit.log`): `POST /cordon` (cordon and uncordon), `GET /drain` (the pods a drain would remove) and `POST /drain` (`kubectl drain --ignore-daemonsets --delete-emptydir-data --timeout=120s`, `--dry-run=server` for a dry run), `POST /evict` (Eviction API), `GET /revisions` and `POST /rollback` (Deployment from its ReplicaSets, StatefulSet from its ControllerRevisions; a JSON patch replaces `/spec/template`), `POST /trigger` (a Job from the CronJob template, owned by it), `POST /pause` (Deployment `spec.paused`), `POST /suspend` (CronJob and Flux `spec.suspend`), `POST /flux` (reconcile annotation, suspend, resume), `POST /argo` (refresh annotation, sync `operation`), `POST /console` (`kubectl exec -- sh -c`, 30 s, 1 MB), `POST /logs`, `POST /logs/lease`, `POST /logs/stop`, `GET /forwards`, `POST /forward`, `POST /forward/stop`, `GET /audit`. New files: `logs.ts`, `forwards.ts`. `state.ts` gained `readAudit`. `main.ts` restores forwards on start and keeps `forwards.json` on shutdown.
- Shared (pure, tested): `shell.ts` (every value quoted, shell and node-shell commands), `actions.ts` (the Actions menu per kind), `ops.ts` (manual Job, revision history, Flux and Argo patches, drain notes, audit parsing, countdown text), and `ForwardView` in `types.ts`. `kinds.ts` NAV gained a "Port forwarding" section whose kind is `PortForwards` (not a registry kind).
- Panel: Actions menu in the drawer header (SDK `mountMenu`), confirm dialog for delete, evict, restart, pause, trigger, suspend and sync; dialogs for scale, rollback (revision list), drain (pods listed first), port forward and Secret reveal (per key, values fetched only while the dialog is open). Edit is the YAML tab in edit mode: a server-side dry run, a line diff, then a confirm before Save; a field conflict offers "Check with force". Logs: follow with the same lease as watches (`logs` events, 250 ms batches, 60 s lease, 5 000 line cap in the frame, 10 pods merged per workload), container select, Previous, Timestamps, Wrap, search with highlight, Copy, Clear. Console: one command at a time, up and down for history. Copy shell command and a selectable command line in Overview. Port forwarding: its own section plus a dock tab (Open through `host.openUrl`, Copy, Stop). Header: Unlock and Lock now buttons, an Activity button (audit log), and a lock banner with a countdown that ticks from the local clock only.
- Layouts: page layout has a bottom dock (Port forwarding tab always, a tab per open log or console, resizable). Rail layout has no dock: Logs and Console are drawer tabs.
- Tests: `bun test` runs 208 tests in 15 files (new: `shell`, `actions`, `ops`, `diff`).

Checked live on staging:

- Real writes (objects named by you): a throwaway CronJob `openchamber-check` in `initech` was created, triggered (the Job appeared), suspended, resumed, edited (annotation, with force after a conflict with kubectl), and deleted together with its Job. `initech/initech-api` was scaled 2 to 3 and back to 2 (twice), restarted (restart annotation set, pods stayed ready), paused and resumed. Node `ip-10-0-20-63.ec2.internal` was cordoned and uncordoned (`unschedulable` true then null). Every write is in `audit.log`.
- Dry runs only (no real write): delete, evict, rollback to a past revision, drain (`kubectl drain --dry-run=server`), scale, restart, pause.
- Logs: a follow stream pushed batched `logs` events, the lease answered known, stop removed it, a lease for a stopped stream answered `UNKNOWN_WATCH`, a bad container answered `INVALID`.
- Port forward: `svc/initech-admin-service:80` came up on a free port and answered HTTP 302 through it. After killing the service process the port closed, `forwards.json` kept the entry, and on the next start the forward was running again with no panel open (HTTP 302 again). Killing the kubectl child restarted it once (status live, restarts 1); killing it three more times marked it failed after 3 restarts. Stop removed it from the list and the file.
- Lock: Unlock and Lock now published `lock` events; the panel showed the banner with the countdown and the Unlock confirm. Every one of the write routes (scale, restart, delete, cordon, drain, evict, trigger, rollback, pause, suspend, flux, argo) answered `LOCKED` on `initech-production-us-east-1`, and no proxy socket was created for production. (Forward and console were also refused in that run, but see the decision below: they are no longer locked.)
- Screenshots in light and dark at page (1100px) and rail (360px) width were taken of the table, drawer, Actions menu, logs, console, YAML edit, rollback, drain, unlock confirm, lock banner, forwards and Activity. I looked at these: page and rail logs, the Actions menu (dark and light), the YAML editor, Activity, the lock banner, the unlock confirm, rollback, drain, forwards, the rail drawer. The console, the light variants of the dialogs and the other rail shots were taken but not looked at.

Decisions and changes from the plan:

- Port forward and console are not locked writes. The first build refused `POST /forward` and `POST /console` with `LOCKED` on a locked protected context; you did not ask for that, and on your answer the guard was removed, so both follow the plan (open on every cluster). Console commands are still written to `audit.log`. Copy shell command is a read. The lock covers the changes the plan lists: apply, delete, scale, restart, rollback, drain, evict, cordon, trigger, pause, suspend, Flux and Argo.
- Not re-run after removing the guard: a live port forward and a live console command on a locked production context (production is not touched, by the rules). The change is the removal of one line in each route.
- On shutdown the service stops the kubectl children but leaves `forwards.json`, so a restart restores them. Only Stop removes an entry. A stale `fwd-*.pid` is cleaned on the next start.
- Edit is the YAML tab, not a separate view. Secrets are edited with their values (fetched only when Edit is chosen, and a warning says so); Reveal values is a dialog, not an Overview change.
- Drain uses `kubectl drain` (a child process), not the API, because it must cordon, respect budgets and wait. Cordon, rollback, pause, trigger, evict and the rest use the REST API.
- Rollback replaces the pod template with the one from the chosen revision (the same result as `kubectl rollout undo --to-revision`, which `kubectl` does with a patch too).
- Flux and Argo actions are routed and tested with patches in unit tests, but the staging cluster has no Flux or Argo CRDs, so they were not exercised live. They appear in the menu only for those groups.
- The lock banner's countdown is a local one-second clock tick while the banner is shown (not a data poll). The only timers are the lease, this tick, and the dock.
- "Ask agent" and Helm actions are not in the menu yet (Phases 5 and 7). Rail layout has no dock, so Port forwarding there is the nav section only.
- The scratch harness that relays service events (`panels.emit` over a local listener) lives in the temp folder, not in `../shared-ui`.

Not verified:

- A real (non-dry-run) delete of a Pod, a real evict, a real drain, a real rollback, and Flux or Argo actions. Delete was verified on a Job and a CronJob only.
- Console against a live pod (the service route was only checked for the `LOCKED` refusal and the panel for layout), and Secret reveal and edit (no Secret was read).
- The OIDC sign-in path and any `northwind-*` cluster (not touched, by the rules).
- The extension installed inside the OpenChamber app: Phase 3 was checked in the scratch harness and against the service directly.

### Phase 4: overviews and metrics (about 2 h) - DONE

Cluster overview, workloads overview, metrics-server usage in tables and drawer, Prometheus detection and charts.

Done when: overview numbers match `kubectl top nodes`, charts draw when Prometheus exists and the overview explains what is missing when not.

**Phase 4 results** (built and checked on `initech-staging-us-east-1`, reads only, plus one approved port forward; throwaway `K8S_STATE_DIR`):

- Stopped before building and reported: the plan's way to reach Prometheus (API server service proxy) times out on staging for `kube-system/prometheus-server` (and for kube-state-metrics): the API server can reach metrics-server's port but not 9090 or 8080 on pods. You chose "proxy first, hidden port forward as fallback" and approved one real forward to `kube-system/svc/prometheus-server:80` for the check. That is what is built.
- Service additions (all reads; every failure is `{ ok: false, code, error }`):
  - `GET /metrics?context&nodes=1&pods=1&disk=1&namespace=`: metrics-server (`/apis/metrics.k8s.io/v1beta1`), compacted to numbers (cores, bytes). A cluster without it answers `status: missing`, one whose APIService has no healthy pod `unavailable` (503), no permission `forbidden`. None of these is an error code. `disk=1` reads each node's root disk from the kubelet (`/api/v1/nodes/<n>/proxy/stats/summary`, 6 at a time, 8 s each), because metrics-server has no disk usage; `diskStatus` says when that was not readable. 10 s cache (30 s for disk) so the rail and the page do not ask twice.
  - `GET /prometheus?context&refresh=1`: finds the server (Services in all namespaces, ranked by the plan's labels and names; alertmanager, exporters, kube-state-metrics, pushgateway, operator and adapter are skipped), probes `vector(1)` through the proxy (6 s), then through a hidden port forward. Answer: `found`, `namespace`, `service`, `port`, `via` (`proxy` or `forward`), `source` (`detected` or `override`), or `found: false` with `reason` `none`, `forbidden` or `unreachable`. Kept 10 minutes (1 minute when nothing was found).
  - `POST /prometheus/service`: the user's own Service for a context (`{ namespace, service, port }` or `{ clear: true }`), saved in `prometheus.json` in the state folder (service-only, the plugin does not read it), then detected again.
  - `POST /prometheus/charts`: `{ scope: pod | workload | node, namespace, name, kind?, addresses? }`. The queries are fixed in `src/shared/prom.ts`; only validated names go in, escaped for PromQL. CPU, memory, network (received, sent) and filesystem, last hour at 60 s, rate window 5 m (wider than a 1 minute scrape). At most 4 series per chart (the biggest), 15 s cache.
  - `POST /watch` takes an optional `fieldSelector` (part of the watch's identity), used for `type=Warning` events.
  - New files `src/service/metrics.ts`, `src/service/prometheus.ts`; `forwards.ts` exports `freePort`; `routes.ts` closes the hidden forwards on shutdown.
- The hidden forward: `kubectl port-forward svc/<name> <free port>:<port>`, not listed under Port forwarding, not written to `forwards.json`, stopped after 5 idle minutes and on shutdown, pid file `sock/fwd-prom-*.pid` (the existing stale cleanup removes it after a crash). It is a read, so it is not locked, and it also opens on production contexts when someone opens the Cluster overview or a Metrics tab.
- Shared (pure, tested): `metrics.ts` (compacting metrics-server answers, `usageNote`), `overview.ts` (`podRequests` with init containers, sidecars and overhead, `clusterTotals`, `summarize`, `warningEvents`), `prom.ts` (candidate ranking, queries, series parsing, chart maths). `format.ts` reads nano and micro cores (`123456789n`).
- Navigation: Cluster > Overview (new default) and Workloads > Overview (first item). Both are special kinds (`ClusterOverview`, `WorkloadsOverview`, like `PortForwards`), drawn by the panel, in rail and page layout.
- Cluster overview: Nodes, Pods and Warnings cards (click opens that list); CPU and Memory cards with Usage and Requests bars (kit Progress, amber from 75%, red from 90%) over Allocatable, Capacity and Limits; Pods card (scheduled of capacity, running, pending, failed); the newest 8 warning events; "Where the numbers come from" (metrics-server state and Refresh usage, Prometheus service and via, Choose service). It is cluster-wide whatever namespace is picked. It uses watches for Nodes, Pods and Warning events, so it updates live. Without metrics-server the usage line says "Install metrics-server for usage" and nothing is an error; without Prometheus the card says what is missing and offers Choose service and Look again.
- Workloads overview: stat cards for Pods, Deployments, DaemonSets, StatefulSets, ReplicaSets, Jobs and CronJobs with counts by health (each opens the list), then the namespace's warning events. Follows the namespace picker.
- Usage in tables: the rail's Node list now shows CPU (`CPU 0.05 / 3.92`) instead of the version, which is the same on every node. Nodes CPU, Memory and Disk show `used / size` with a thin bar (a node metrics-server has not measured yet shows `- / size`, never a bare size; with no metrics-server they show allocatable as before). Pods got CPU and Memory columns. Both tables show "Usage as of HH:MM:SS" and a Refresh usage button. The drawer's Overview has a Usage section for pods (against limit, else request) and nodes.
- Metrics tab (Pods, Nodes, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs): four SVG charts, theme colors only (`--oc-primary`, `--oc-info`, `--oc-warning`, `--oc-muted`), hover readout, legend with the latest value, a dot for a series with one reading (a brand new pod or node). Workloads are matched to their pods by name pattern (`name-<hash>-<id>` for Deployments, `name-<n>` for StatefulSets and so on). Nodes are matched on node_exporter's `instance` by name or address.
- Tests: `bun test` runs 262 tests in 18 files (new: `metrics`, `overview`, `prom`; `kinds` updated for the two Overview entries and the new default).

Checked live on staging:

- Overview against kubectl, taken at the same moment from the same JSON: nodes 9, CPU allocatable 111.09 cores, memory allocatable 194.9 GiB, pod capacity 834, requests 33.84 cores and 55.14 GiB, 107 scheduled pods; the panel's `clusterTotals` and an independent Python sum agree to the digit. Usage: panel 8.197 cores and 25.81 GiB against `kubectl top nodes` summed 8.202 cores and 25.81 GiB (kubectl rounds each node to whole millicores and truncates memory to Mi). Per node, CPU matched `kubectl top nodes` to within 1m and memory to within 1 MiB.
- Disk from the kubelet worked on all nodes (about 12 of 49.9 GiB used on the first node). Pod usage in `initech` matched `kubectl top pods` for the pods compared.
- Prometheus: detected `kube-system/prometheus-server` (port 80, label `app.kubernetes.io/name=prometheus`), proxy timed out, hidden forward answered. Charts for a pod (per container CPU and memory, network), a Deployment (totals) and a node (CPU percent, memory, network, filesystem) all returned 38 to 61 points. A name with a quote and a PromQL fragment was refused with `BAD_REQUEST` and never reached Prometheus. Setting an override to a Service that does not exist answered `found: false, unreachable`; clearing it detected `prometheus-server` again. A `type=Warning` watch returned only warnings (8 of the 795 events).
- The hidden forward's lifetime: it stopped by itself about 6 minutes after its last use (5 idle minutes plus the sweep), and it was gone each time the service was stopped by a rebuild.
- Screenshots (light and dark, page 1100px and rail 360px): both overviews, Nodes and Pods tables, node and pod drawers (Usage and Metrics), a Deployment's Metrics, a chart hover, and with `metrics-missing` plus `prom-none` and with `metrics-down` plus `prom-unreachable` (injected in the scratch harness) the overview, Nodes, the Metrics tab and the Choose service dialog. I looked at: page dark overview (top and bottom), rail light overview, page dark workloads overview, rail dark and page light overview with nothing installed, rail light overview with metrics-server down and Prometheus unreachable, page dark and light Nodes, page light node drawer with Usage, page dark node Metrics, rail dark Nodes list and node Metrics, page light Pods and pod Metrics with hover, page dark node Metrics with nothing installed, rail light Choose service dialog. Taken but not looked at: the other light and rail variants.

Decisions and changes from the plan:

- Prometheus transport: proxy first, then a hidden port forward (above). The first detection on staging takes about 8 seconds (6 s proxy timeout, then the forward); after that it is cached for 10 minutes.
- Usage follows the lease timer (your decision after review). metrics-server cannot be watched, so usage is read when a view opens, on every lease tick (30 s, only while the panel is visible, and only when the numbers are older than 20 s), and on Refresh usage. It is the same single timer, not a new one. Node disk is cached for 2 minutes in the service, so a tick costs one metrics call, not one kubelet call per node.
- Disk usage comes from the kubelet through the API server (metrics-server has none), not from Prometheus. A node whose kubelet does not answer shows allocatable instead and the bar says "Disk usage is not readable here".
- Pod and workload Filesystem: this Prometheus has `container_fs_usage_bytes` only for the node root (containerd on EKS), so the chart falls back to `kubelet_container_log_filesystem_used_bytes` and says so ("This cluster does not report disk use per container. Showing the size of the log files instead.").
- Percent charts (node CPU) start from the data's scale (at least 0 to 10%) and stop at 100%, so a quiet node is not a flat line. Byte charts round in steps of 1024.
- "Prometheus service" override lives in the Cluster overview ("Change service", "Choose service") and in an empty Metrics tab, not in a context menu (the header has no context menu).
- (Kept as is after review.) The Cluster overview opens a Prometheus detection as soon as it is shown (a read of Services plus a probe, and a hidden forward if the proxy fails). It is the default section, so that happens on every cluster you open. Tell me if you would rather detect only when a Metrics tab or "Look again" asks.
- The page layout's bottom dock keeps its 300px, so on a short window the overview scrolls. Resize the dock or close it to see more.

Not verified:

- The 30 s usage refresh on the lease tick (added after review): built, typechecked and built into the bundle, but not watched live. Check in the app: open Cluster Overview or Nodes, wait up to a minute, and "usage as of" should move on its own.
- A cluster whose API server can reach Prometheus through the service proxy (`via: proxy`): staging cannot, so that path only has the code and the unit tests. Same for a real cluster with no metrics-server or no Prometheus: those states were drawn with injected answers in the scratch harness, and the service mapping (`NOT_FOUND`, 503 and `FORBIDDEN` to `missing`, `unavailable`, `forbidden`) is unit-tested.
- `container_cpu` and network charts for a DaemonSet, StatefulSet or Job (no workload of those kinds was opened on staging beyond the name patterns in tests); node charts on a cluster without node_exporter.
- A service crash (not a normal stop) with a hidden forward open: the next start removes `fwd-prom-*.pid` files the same way as for forwards, but a killed service was not simulated here.
- Production and `northwind-*` clusters (not touched, by the rules), and the extension in the installed app beyond the live reload that came with each rebuild.


### Phase 5: Helm, custom resources, GitOps (about 2 h) - DONE

Helm releases with values, manifest, history, rollback, upgrade with edited values, uninstall. Chart repo search and install only if time allows (mark as stretch). CRD browser with printer columns. Flux and Argo views when their CRDs exist.

**Phase 5 results** (built and checked on `initech-staging-us-east-1`: reads, and dry runs only; throwaway `K8S_STATE_DIR`; no real Helm write was made):

- Helm (service, new `src/service/helm.ts`, all through the `helm` binary, JSON output, extended PATH, `--kube-context` and the project's safe kubeconfig). Routes: `GET /helm/releases` (one namespace or all, every release state), `GET /helm/values` (`all=1` for computed values, optional `revision`), `GET /helm/manifest`, `GET /helm/history`, `GET /helm/chart-source`, `POST /helm/rollback`, `POST /helm/upgrade`, `POST /helm/uninstall`. The three writes call `guard` first, take `dryRun`, and append to `audit.log` (a failed run that helm may have left as a failed revision is logged too, as `... (failed)`). Names, revisions, chart references and versions are validated before any argument is built, so a name can never read as a flag.
- Redaction (`src/shared/redact.ts`, extended): `redactValues` hides every text and number under a key matching `/(password|secret|token|key|credential)/i` (a whole subtree when the key is an object), and the value of a `{ name: DB_PASSWORD, value: x }` entry. `redactManifest` replaces every `kind: Secret` document (also inside a `List`, and an unparseable one that says it is a Secret) with its keys and `<redacted, N bytes>`, and leaves every other document byte for byte. `restoreRedacted` is the reverse for Upgrade: a value still reading `<redacted>` gets its real value back inside the service; one that cannot be found refuses the upgrade (`INVALID`), so the placeholder is never written. The panel never receives raw values, raw manifests or the release record. Unit tests cover each rule.
- Upgrade with edited values: the panel edits the release's own values (as `helm get values` has them, hidden where secret-like). Check changes runs `helm upgrade --reset-values --dry-run=server -o json` and answers with a manifest diff of what Helm renders (see the close-out checks: Helm 4's server dry run does not test the objects against the cluster) (document by document: added, removed, changed lines with context); the Upgrade button is enabled only for the checked text and chart, then asks once more (inside the same dialog). The real run passes the revision from the check (`expectedRevision`): if the release moved, it answers `CONFLICT`. The chart is the exact version found in a repository from `helm repo list` (`helm search repo`, exact version only), else rebuilt from the release record (the Secret or ConfigMap `sh.helm.release.v1.<name>.v<N>`: two base64 layers and gzip, files written to a `0700` temp folder, file names checked, folder deleted in a `finally`), else a chart the user names (`repo/chart` with the repo in `helm repo list`, or `oci://`; never a path or a URL). A chart with subcharts cannot be rebuilt: helm keeps them neither in the record nor always in the metadata (Datadog and Prometheus list them only in `Chart.lock`), so both are read and the rebuild is refused with a clear message.
- Rollback and uninstall: rollback lists the earlier revisions, runs `helm rollback --dry-run=server` and shows the diff between the current manifest and the chosen one (Helm 4's dry run does nothing on the cluster at all, which was read in its source). Uninstall lists every object it removes (from a dry run), has a "Keep the release history" switch and one destructive button.
- Custom resources: `GET /crds` (new `src/service/crds.ts`, 60 s cache) reads the CRD list once and keeps only kind, group, scope, the served version (the one the cluster's discovery uses for the group, so the columns match the list), `additionalPrinterColumns` and whether the schema has `status.conditions`. A CRD that is not Established is left out. The navigation has one section per API group after Definitions (`cr:<plural>.<group>` ids, titles like `ExternalSecrets`). The table is Name, Namespace, the declared columns (ordinary ones first, wide ones after, at most 8), then Age; Name and Age printer columns are not repeated; a `date` column shows as an age; numbers sort as numbers; a Ready or Status column gets a dot for the usual words; with `status.conditions` and no state column of its own a Status column is added. JSONPath is a small tested reader (`src/shared/jsonpath.ts`: paths, indexes, negative indexes, `[*]`, `[?(@.type=="Ready")]`, quoted and escaped keys). The watch, drawer, YAML, Events and Actions are the ones every kind uses.
- GitOps: Flux (Kustomization, HelmRelease, GitRepository, HelmRepository, OCIRepository) and Argo CD (Application, ApplicationSet, AppProject) have curated views in `src/shared/gitops.ts` and two sections ("GitOps: Flux", "GitOps: Argo CD") that exist only when the CRDs do. Flux: Ready (with Suspended, Stalled, Reconciling), Revision (hash shortened to 7), Source or Chart or URL, Last reconcile, Message. Argo: Sync and Health as dots, Revision, Target, Project, Destination, Last reconcile, Message, and a header status. These kinds appear in GitOps and not again under their API group. The existing Reconcile, Suspend and Resume (Flux) and Refresh and Sync (Argo CD Application) from the Actions menu work on these rows: the Suspend label now follows `spec.suspend` for every Flux kind (it said "Suspend" for the source kinds before).
- Navigation (`buildNav`, `src/shared/crds.ts`): Lens order, Events, Helm, Access control, Custom resources (Definitions, then a section per API group), GitOps: Flux, GitOps: Argo CD, Port forwarding. Both layouts: the left nav in the page layout, and the section select in the rail (its hint is the section or API group). Opening Definitions reads the CRD list again, so a CRD installed since appears.
- Panel: `ResourceView` now takes optional `source` (a list that is not a watch), `view`, `watchKind`, `renderDrawer`, `toolbarExtra` and `notice`, so Helm and custom resources use the same list, search, sort, rail list, resizable drawer and error states as every other kind. New: `src/app/helm/` (`useHelmReleases`, `HelmReleases`, `HelmDrawer`, `HelmDialogs`, `ManifestDiffView`, `useRead`) and `src/app/useCrds.ts`. The table gained a `tone` cell (a dot before the text) for Ready, Sync and Health. Helm has no watch: it reads when the view opens, on Refresh and after a change the panel made; it never polls (no new timer). The header dot reads "Live" once Helm answered (it means the cluster is reachable, not that the list is live).
- Shared service change list: `k8s.ts` exports `discoverAll` and `forgetDiscovery`; `routes.ts` has the nine new routes; `GET /crds` with `refresh=1` forgets the cluster's cached discovery so a new CRD can be opened. `src/app/detail/diff.ts` moved to `src/shared/diff.ts` (the old path re-exports it) and gained `withContext`, `manifestDocs` and `diffManifests`. `KindView.status` may now return null.
- Tests: `bun test` runs 365 tests in 22 files (new: `helm`, `crds`, `jsonpath`; extended: `redact`, `diff`, `actions`, `kinds`).

Checked live on staging (reads and dry runs only):

- Helm list: all 20 releases, all namespaces, with Name, Namespace, Chart, Revision, Version, App version, Status, Updated. History for `contracts` (10 revisions, newest 251).
- Redaction against the real data: for all 20 releases, `helm get values --all` was compared with the route's answer by path with an independent script. 67 secret-looking leaves were all `<redacted>`, no other value changed. Every `kind: Secret` document in the 20 manifests (8 of them, 9 data values) was checked: none of its values appear in the answer. (The one CA certificate that does appear also sits in non-Secret webhook `caBundle` fields: it is public, not from the Secret.)
- Upgrade dry run on `contracts`: the chart rebuilt from the release record with its own values gave 0 changed, 0 added, 0 removed, 15 unchanged documents, so the rebuild is faithful for this chart. Changing `appVersion` to a test value showed 3 changed Deployments and nothing else. `helm history` afterwards: still 250 and 251. A stale `expectedRevision` answered `CONFLICT`; a leftover `<redacted>` answered `INVALID`; Datadog and Prometheus answered "has subcharts" and the rebuild was refused; `chart-source` for `contracts` answered default `release`, no repo candidates (only bitnami and kubeshark are added).
- Rollback dry run to 250 showed the same 3 Deployments' image label lines; the current revision, a missing revision and a bad namespace were refused; uninstall dry run listed 15 objects. Nothing was changed.
- Writes on `initech-production-us-east-1` (rollback, upgrade, uninstall) answered `LOCKED` and no proxy socket was created for it. No `northwind-*` cluster was touched.
- CRDs: 46 CRDs read in 0.6 s. The navigation drew one section per API group (for example `external-secrets.io`: ExternalSecrets, ClusterSecretStores...; `elbv2.k8s.aws`: TargetGroupBindings), `ExternalSecrets` listed with Store, Refresh Interval, Ready and Age from the CRD, Ready as a dot, and the drawer showed the printer columns, a Status from conditions, YAML and Events.
- Screenshots (light and dark, page 1100px and rail 360px) with a scratch harness in the temp folder (the shared-ui harness plus injected answers, forced failures, and a block on every real write): the Helm list, drawer Overview, Values, Manifest (with a hidden Secret), History, the Actions menu, Rollback with its diff, Upgrade before and after Check changes, Uninstall, the custom resource list and drawer, the rail list, drawer and Upgrade, a FORBIDDEN answer, and the GitOps views. I looked at: page dark and light Helm drawer, Values (light), Manifest (dark), History (dark), the menu (dark), Upgrade and Upgrade-check (dark), Uninstall (light), Rollback (dark), the custom resource list and drawer, the Flux list, menu (light) and drawer, the Argo list and drawer, the OCIRepository list, rail Helm list and Upgrade, rail Argo drawer, and the FORBIDDEN note. Taken but not looked at: the other light and rail variants and the AUTH_EXPIRED one.

Decisions and changes from the plan:

- Upgrade chart source ("Both", your decision): a repo with the exact version first, else rebuilt from the release record, else a chart you name. Staging's `contracts` came from a local chart, so only the rebuild path could be run live.
- Rollback dry run: Helm 4 does nothing in any dry run (it returns before touching the cluster), so the preview is the manifest diff; the dry run only proves the revision exists.
- GitOps kinds are listed in GitOps only, not again under their API group. Other kinds in `argoproj.io` (Rollouts) stay under Custom resources.
- Chart repo search and install is the stretch item. It is not built.
- The Charts entry of the Helm section (in the plan's table) is left with the stretch: the Helm section has Releases only.
- The Argo column is named "Sync" (its values are Synced, OutOfSync, Unknown).
- `Flux HelmRelease` objects can hold `spec.values` in plain text. The panel shows the object as the cluster has it (like any custom resource). Phase 7's agent redaction (mentions, Ask agent, plugin tools) must run `redactValues` over `spec.values` of those.

Not verified:

- A CRD whose served version differs from the group's preferred one, a CRD with `priority` columns and CRD pages on a very large cluster (hundreds of CRDs, each with a large schema: the one read keeps only the small part, but it does transfer the whole list once a minute at most).
- Real Helm rollback, upgrade and uninstall, the repo path of Upgrade and the Flux and Argo CD views and actions were verified later against throwaway objects (see "Phase 5 close-out checks" below).
- An expired SSO login while a Helm call runs (the code maps helm's output to `AUTH_EXPIRED`; unit tested, not triggered), and the extension installed in the app beyond the live reload.

**Phase 5 close-out checks** (you approved throwaway objects on `initech-staging-us-east-1`; a fresh throwaway `K8S_STATE_DIR`; all removed afterwards):

- Objects: namespace `openchamber-check`, a Helm release `oc-check` (`bitnami/nginx` 25.2.14, `replicaCount=0`, so no pods or images), and three made-up CRDs (`kustomizations.kustomize.toolkit.fluxcd.io`, `gitrepositories.source.toolkit.fluxcd.io`, `applications.argoproj.io`, label `openchamber-check`) with four objects whose status was set by hand. No controller acts on them. Cleanup: CRDs deleted by label, namespace deleted. Checked afterwards: no CRD from either group, no namespace, no `oc-check` release, 20 releases as before, no `k8s-helm-*` temp folder left. `~/.config/openchamber-k8s` was not used.
- Helm, through the panel (scratch harness with its write block lifted for `openchamber-check` only): Upgrade of `oc-check` found `bitnami/nginx 25.2.14` as the chart, showed the values diff and 6 changed objects, then confirmed and wrote revision 2; the drawer and list updated in place. The last Uninstall, also from the panel, removed the release (it was already `uninstalled` with kept history) and the drawer then said "This release is gone".
- Helm, through the service routes: a stale `expectedRevision` answered `CONFLICT`; a real upgrade the API server refused (`service.type: Bogus`) came back as `K8S_ERROR` and left revision 3 as `failed`; rolling back to revision 1 (dry run showed the one Service change first) created revision 4; uninstall with `keepHistory` (route only, not clicked in the panel) left the release as `uninstalled` with its history. Every write is in `audit.log` with the right verb, including `helm upgrade (failed)`, `helm rollback to 1` and `helm uninstall (keep history)`.
- Lock: with staging marked protected (throwaway state), real upgrade, rollback, uninstall, Flux reconcile, suspend, Argo sync and refresh all answered `LOCKED` and changed nothing; the uninstall dry run was still allowed.
- Flux and Argo CD, live against the made-up CRDs: `/crds` returned the three entries; the GitOps sections appeared and the curated views drew the real objects (Ready and Not ready, Sync, Health, revision shortened); `/list` worked with the served version. Reconcile (annotation `reconcile.fluxcd.io/requestedAt`), Suspend and Resume (`spec.suspend` true then false, also on a GitRepository), Argo Refresh (annotation) and Argo Sync (`operation: {sync: {}}`) all changed the objects as `kubectl` showed. Wrong-family calls answered `INVALID`. The same actions clicked in the panel (Reconcile on a Kustomization, Refresh and Sync with its confirm on the Application) worked and were audited with the project.
- Findings that changed the code:
  - Helm 4's `--dry-run=server` does not test objects against the API server: the `Bogus` Service type passed Check changes and only failed on the real run. The text "The cluster accepted this change" in the Upgrade confirm step was wrong for Helm. It now says Helm rendered the chart, and warns that a change the cluster refuses leaves a failed revision that can be rolled back. (The YAML editor's Save keeps its wording: that dry run is a real Kubernetes server-side dry run.)
  - Helm 4 prints a `level=WARN msg=...` log line before its `Error:` line. Errors now show the `Error:` line only (`cleanHelmOutput`, tested).
  - The uninstall dialog for a release that is already `uninstalled` now says the objects are gone and that uninstalling again deletes the history.
  - `bitnami/nginx` has subcharts, so "the chart kept in the release" correctly was not offered for it (only the repo choice).
- Your click-through in the app, and what came of it:
  - Values Copy showed no `<redacted>`: expected for `contracts`, which has no secret-looking value (my instruction was wrong). Releases with hidden values: `gitlab-agent` and `gm-mcp` (one each, more with Computed values on); `external-secrets` has a hidden Secret document in its Manifest.
  - A row "blinked" on hover: real, and old (the rail list since Phase 2). The SDK's `mountList.update()` repaints every row, and shared-ui's `useKit` calls `update` after every render, so any watch event rebuilt the whole list under a resting mouse. Reproduced in the scratch harness (now with an event relay): a rail Pods list rebuilt 340 rows in 75 s and the hovered row disappeared; after the fix, 0 rebuilds. `src/app/kit.tsx` now repaints a control only when its data changed (`src/app/stable.ts`: a signature of the props, and callbacks that always call the newest closure, tested). The same applied to the nav, menus, tabs and dialog lists. `../shared-ui` was not touched: say if you want the same change there.
  - YAML copied but the Events tab showed nothing: the tab works for custom resources (checked: it lists the `UpdateFailed` event of `contracts-staging-pdf-signing-certificate`, `x262`), but only that one ExternalSecret has any event on staging, because Kubernetes keeps events for about an hour. Every other one shows "No events".
- Two more checks, with throwaway objects (removed afterwards):
  - Served version: a CRD `widgets.check.openchamber.dev` with `v1beta1` (storage), `v1` (served, preferred) and a non-served `v1alpha1`, each with its own printer columns. `/crds` answered version `v1` with the `v1` columns only, the list came back as `check.openchamber.dev/v1`, and the panel drew FromV1 and Size.
  - Expired login: a kubeconfig (named by a project `.envrc`, outside the repo) whose auth plugin prints "Token has expired". `/helm/releases`, `/helm/history`, `/list`, `/crds`, `/metrics`, `/watch` and a Helm upgrade dry run all answered `AUTH_EXPIRED` with the sign-in action in under a second, no browser opened, and the panel drew the "Sign in to this cluster again" banner with Try again. Helm words this as "kubernetes cluster unreachable ... getting credentials", which is why the unreachable rule skips text that mentions credentials or tokens.
- Still not verified: a very large cluster's CRD list; real Flux and Argo CD controllers (the objects here are inert); the full click-through again after the blink fix.

### Phase 6: EKS discovery and sign-in (about 1 h) - NEXT

Discovery, Add to kubeconfig with confirm, Sign in for SSO and OIDC.

Done when: an expired SSO session shows Sign in, and signing in brings the views back without reopening the panel.

### Phase 7: agent surfaces (about 3 h)

Redaction with tests, Ask agent, mentions with index, instructions, skill, plugin tools with lock and approval flow, the four blocks, tools presentation.

Done when: in a chat, `@` finds a pod and the agent gets redacted text; the agent runs `k8s_get` and `k8s_logs`; `k8s_scale` on production returns Locked, the agent draws `K8sApprove`, Approve lets the retry through once, a second retry is Locked again.

### Phase 8: verify and hand over (about 1 h)

`bun run build`, `bunx openchamber-guest-check`, `bunx tsc --noEmit`, `bun test`. Screenshots with the shared-ui harness (`bun harness/server.ts --root ../k8s ...`), light and dark, 360px and page width, fixtures recorded from staging and kept out of git. README with what it does and where to look. End with the install link:

```markdown
[Install Kubernetes](openchamber://extensions/install?path=/Users/example/Development/OpenChamber%20Extensions/k8s)
```

Before editing `../shared-ui/USAGE.md` to add this extension to the Dependents table, ask the user: it is another project.

## Rules for the build

- No em dashes anywhere (code comments, UI strings, docs).
- Only `--oc-*` colors. No hardcoded hex.
- Nothing in `../shared-ui` unless a second extension needs it, and then ask first.
- Never print or log tokens, kubeconfig credentials or Secret values.
- Quiet: no page polling for data (leases are the only timer), no toast without a click behind it.
- User words: "Clusters", "Pods", "Sign in", never "service" or "payload".

## Spike results

Phase 0, run on this machine (kubectl v1.37.2, OpenChamber 2.7 desktop, opencode v2.2.7). The service was run with the desktop app's own binary and `ELECTRON_RUN_AS_NODE=1`, with an environment limited to what the host passes (`PATH`, `HOME`, `TMPDIR`, `LANG`, `OPENCHAMBER_*`). The spike routes live in `src/service/spikes.ts`.

| Spike | Result |
|---|---|
| a. Service PATH, kubectl | **Pass.** The running services under the app have a `PATH` that already contains `/opt/homebrew/bin` (the app was started from a shell). With a Finder-style `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin` it does not, and the extended `PATH` from `bins.ts` fixes it: `kubectl`, `aws`, `helm` and `kubectl-oidc_login` are all found. `kubectl --context initech-staging-us-east-1 get ns` returns 16 namespaces under both paths (exit 0, aws exec auth works with the extended `PATH`). |
| b. `kubectl proxy --unix-socket` | **Pass.** Proxy ready in about 100 ms. `GET /api/v1/namespaces` over the socket from Node `http.request({ socketPath })` returned 200 with 16 namespaces (`contracts`, `datadog`, `default`, ...). `GET /apis/metrics.k8s.io/v1beta1/nodes` also returned 200, so metrics-server exists on staging. The socket sits in a `0700` folder and is removed on shutdown. |
| c. `nw-oidc` user | **kubelogin.** `exec.command` is `kubectl` with args `oidc-login get-token --oidc-issuer-url=https://idp.example.com/oauth2/<issuer-id> --oidc-client-id=<client-id>` and scopes `email`, `offline_access`, `profile`, `openid`. `apiVersion` is `client.authentication.k8s.io/v1beta1`, `interactiveMode` is `IfAvailable`, no `env`. The plugin binary is `/opt/homebrew/bin/kubectl-oidc_login` and a token cache exists in `~/.kube/cache/oidc-login`. Sign in for these contexts runs `kubectl --context X get ns` from the service (kubelogin opens the browser). Not exercised: an expired token, to avoid opening a browser unprompted. |
| d. OpenCode plugin | **Pass.** Loaded through `OPENCODE_CONFIG_CONTENT` with `opencode run --standalone`. `execute(input, ctx)` can spawn: `await import('node:child_process')` works (`spawnSync('kubectl', ...)` returned the current context), and a `Bun` global exists. The second argument holds `{ sessionID, agent, messageID, id, progress (function), signal }`: **no directory**. The directory comes from `setup(ctx)`: `ctx.location.directory` and `ctx.location.project.{id, directory, canonical}`, which setup can capture in a closure. `ctx.session.get(sessionID)` also exists. `process.cwd()` equals `location.directory` in this run. Phase 7 uses `ctx.location.directory` first, then `process.cwd()`, and must confirm in the app that a shared `opencode serve` calls `setup` once per project. |
| e. Terminal | **Dropped** by the user. No terminal app is launched or driven. Before the decision, a few Ghostty windows were opened with `open -na Ghostty` and closed again (they were killed by pid; the user's own Ghostty process was not touched). Shell is "Copy shell command" through `host.writeClipboard`. |
| f. `host.emit` to panel and page | **Pass.** From the `keepRunning` service, `host.emit('spike', ...)` reached both surfaces: after installing and approving, the user pressed Send test events and saw 3 `spike` lines in the rail panel and 3 in the full page. The service also started by itself on approval (`keepRunning`), and the service side was checked against a fake callback listener (`POST /service/call`, `panels.emit`). |

Other findings:

- `bun add preact` installed Preact 11.2 (the manifest draft said `^10`); Linear uses `^11.2.0` too, so the scaffold follows it.
- `bun init` generated `CLAUDE.md`, `index.ts` and `.cursor/`; they were removed.
- `bun test` exits 1 with no test files, so the `test` script passes `--pass-with-no-tests` until Phase 1 adds tests.
- The plugin still ships the `k8s_spike_plugin` tool (it reports runtime facts). Remove it in Phase 1 once the in-app plugin check is recorded.
