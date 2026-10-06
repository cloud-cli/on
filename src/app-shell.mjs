import { onDestroy, onInit, ref } from "@li3/web";

export default function setup() {
  const activeSection = ref("runs");
  const user = ref({ name: "", email: "" });
  const userAuthenticated = ref(false);
  const userInitial = ref("U");

  const syncSection = () => {
    const path = window.location.pathname;
    activeSection.value = path.startsWith("/settings")
      ? "settings"
      : path.startsWith("/workflows")
        ? "workflows"
        : "runs";
  };

  const setActive = (section) => {
    activeSection.value = section;
  };

  onInit(() => {
    syncSection();
    window.addEventListener("popstate", syncSection);
    void fetch("/api/auth/session", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((session) => {
        if (!session?.authenticated || !session.user) return;
        user.value = session.user;
        userAuthenticated.value = true;
        userInitial.value = String(session.user.name || session.user.email || "U")
          .trim()
          .slice(0, 1)
          .toUpperCase();
      })
      .catch((error) => console.error("Unable to load the signed-in profile", error));
  });

  onDestroy(() => window.removeEventListener("popstate", syncSection));

  return { activeSection, user, userAuthenticated, userInitial, setActive };
}
