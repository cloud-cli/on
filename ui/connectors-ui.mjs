import { onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const workspaceId = parts[2] || new URL(location.href).searchParams.get("workspaceId") || "";
  const basePath = `/ui/workspaces/${encodeURIComponent(workspaceId)}/connectors`;
  const selectedId = ref(parts[4] && parts[4] !== "new" ? parts[4] : "");
  const editing = ref(parts[4] === "new" || Boolean(selectedId.value));
  const connectors = ref([]);
  const id = ref("example");
  const name = ref("Example");
  const source = ref(
    `kind: connector\nid: example\nname: Example\nsteps:\n  - id: normalize\n    eval: "({ type: 'sample.received', data: { body } })"\n`,
  );
  const enabled = ref(false);
  const published = ref(false);
  const hasDraft = ref(false);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref("");
  const oneTimeUrl = ref("");
  const request = async (path, options = {}) => {
    const response = await apiFetch(path, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        "X-Workspace-ID": workspaceId,
      },
    });
    const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }
    return result;
  };
  const api = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/connectors`;
  const refresh = async () => {
    loading.value = true;
    try {
      connectors.value = (await request(api)).connectors || [];
      if (selectedId.value) {
        const item = connectors.value.find((entry) => entry.id === selectedId.value);
        if (item) {
          id.value = item.id;
          name.value = item.draftName || item.name;
          source.value = item.draftYaml || item.sourceYaml;
          enabled.value = item.enabled;
          published.value = item.published;
          hasDraft.value = item.hasDraft;
        } else {
          throw new Error("Connector not found in this workspace.");
        }
      }
    } finally {
      loading.value = false;
    }
  };
  const act = async (fn) => {
    error.value = "";
    busy.value = true;
    try {
      await fn();
    } catch (cause) {
      error.value = cause.message || "Request failed";
    } finally {
      busy.value = false;
    }
  };
  const setId = (event) => {
    id.value = event.target.value;
  };
  const setName = (event) => {
    name.value = event.target.value;
  };
  const setSource = (event) => {
    source.value = event.target.value;
  };
  const save = () =>
    act(async () => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id.value) || !name.value.trim() || !source.value.trim()) {
        throw new Error("Enter a valid ID, name, and connector YAML.");
      }
      const result = await request(`${api}/${encodeURIComponent(id.value)}/draft`, {
        method: "PUT",
        body: JSON.stringify({ name: name.value.trim(), sourceYaml: source.value }),
      });
      selectedId.value = result.connector.id;
      editing.value = true;
      if (location.pathname.endsWith("/new")) {
        history.replaceState({}, "", `${basePath}/${encodeURIComponent(selectedId.value)}`);
      }
      await refresh();
    });
  const publish = () =>
    act(async () => {
      const result = await request(`${api}/${encodeURIComponent(selectedId.value)}/publish`, { method: "POST" });
      oneTimeUrl.value = result.url ? new URL(result.url, location.origin).toString() : "";
      await refresh();
    });
  const toggleEnabled = (event) =>
    act(async () => {
      const result = await request(`${api}/${encodeURIComponent(selectedId.value)}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: event.target.checked }),
      });
      oneTimeUrl.value = result.url ? new URL(result.url, location.origin).toString() : "";
      await refresh();
    });
  const remove = () =>
    act(async () => {
      if (!confirm(`Permanently delete connector ${name.value}? Its ingress URL will stop working.`)) {
        return;
      }
      await request(`${api}/${encodeURIComponent(selectedId.value)}`, { method: "DELETE" });
      selectedId.value = "";
      editing.value = false;
      location.assign(basePath);
    });
  const copyUrl = async () => {
    await navigator.clipboard.writeText(oneTimeUrl.value);
    oneTimeUrl.value = "";
  };
  const dismissUrl = () => {
    oneTimeUrl.value = "";
  };
  onInit(async () => {
    try {
      await refresh();
    } catch (cause) {
      error.value = cause.message;
    }
  });
  return {
    basePath,
    selectedId,
    editing,
    connectors,
    id,
    name,
    source,
    enabled,
    published,
    hasDraft,
    loading,
    busy,
    error,
    oneTimeUrl,
    setId,
    setName,
    setSource,
    save,
    publish,
    toggleEnabled,
    remove,
    copyUrl,
    dismissUrl,
  };
}
